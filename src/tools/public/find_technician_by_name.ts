import { z } from 'zod';
import type { ToolDef } from '../types';
import type { Env } from '../../env';
import { McpError } from '../../errors';
import { readST, type ReadSTContext } from '../../st';
import { defaultShaper } from '../../response-shape';
import { listRoster, matchByName, parseNumericId, BUSINESS_UNITS_PATH, TECHNICIANS_PATH, type RosterEntry } from '../../st-roster';

interface Args { name: string }

async function businessUnitName(
  env: Env,
  ctx: ReadSTContext,
  businessUnitId: number | null,
): Promise<{ name: string | null; warning?: string }> {
  if (businessUnitId === null) return { name: null };
  let roster;
  try {
    roster = await listRoster(env, ctx, BUSINESS_UNITS_PATH);
  } catch {
    return {
      name: null,
      warning: `business_unit_unresolved: the live business-units lookup failed, so businessUnitId ${businessUnitId} could not be resolved to a name`,
    };
  }
  const row = roster.rows.find((r) => r.id === businessUnitId);
  if (row) return { name: row.name };
  if (roster.truncated) {
    return {
      name: null,
      warning: `business_unit_unresolved: businessUnitId ${businessUnitId} was not among the first pages of a truncated business-units roster`,
    };
  }
  return { name: null };
}

async function found(
  env: Env,
  ctx: ReadSTContext,
  t: RosterEntry,
  resolved: 'numeric' | 'exact' | 'prefix' | 'contains',
  warnings: string[] = [],
) {
  const businessUnitId = t.businessUnitId ?? null;
  const bu = await businessUnitName(env, ctx, businessUnitId);
  const allWarnings = bu.warning ? [...warnings, bu.warning] : warnings;
  return {
    status: 'found' as const,
    technician_id: t.id,
    technician_name: t.name,
    business_unit_id: businessUnitId,
    business_unit: bu.name,

    role: null,
    resolved,
    _source: 'live' as const,
    ...(allWarnings.length ? { _warnings: allWarnings } : {}),
  };
}

export const find_technician_by_name_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'find_technician_by_name',
  description:
    'Resolve a technician name (full or partial) to their technicianId and roster profile. ' +
    'Matches exact > prefix > contains (case-insensitive) against the active technician roster; ' +
    'a numeric string is looked up by ID (an inactive technician\'s ID also returns not_found). ' +
    'Returns status found | ambiguous (with candidates) | not_found. ' +
    "`role` is always null — ServiceTitan's public technicians endpoint exposes only role IDs, not names. " +
    'Use this before ID-only tools (payroll_job_timesheets_list, list_jobs_today technicianId). Source: live ST (Settings technicians).',
  zodSchema: {
    name: z.string().min(1).describe('Technician name, full or partial, or a numeric technicianId as a string.'),
  },
  stEndpoint: { method: 'GET', path: '/settings/v2/tenant/{tid}/technicians', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const ctx = { actor, correlation };
    const id = parseNumericId(args.name);
    if (id !== null) {
      try {
        const row = await readST<RosterEntry>(env, ctx, `${TECHNICIANS_PATH}/${id}`);

        if (row.active === false) return { status: 'not_found', _source: 'live' };
        return await found(env, ctx, row, 'numeric');
      } catch (e) {
        if (e instanceof McpError && e.code === 'not_found') return { status: 'not_found', _source: 'live' };
        throw e;
      }
    }
    const roster = await listRoster(env, ctx, TECHNICIANS_PATH);
    const warnings = roster.truncated ? [`roster_truncated: only the first pages of the roster were searched`] : [];
    let match;
    try {
      match = matchByName(roster.rows, args.name, 'technicianName');
    } catch (e) {
      if (e instanceof McpError && e.code === 'validation_error' && /not found/.test(e.message)) {
        return { status: 'not_found', _source: 'live', ...(warnings.length ? { _warnings: warnings } : {}) };
      }
      throw e;
    }
    if (match.ambiguous) {
      return {
        status: 'ambiguous',
        resolved: match.resolved,
        candidates: match.candidates,
        _source: 'live',
        ...(warnings.length ? { _warnings: warnings } : {}),
      };
    }
    const row = roster.rows.find((r) => r.id === match.id)!;
    return found(env, ctx, row, match.resolved, warnings);
  },
  transformResult: defaultShaper,
};
