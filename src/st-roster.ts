import type { Env } from './env';
import { McpError } from './errors';
import { readSTPaged, type ReadSTContext } from './st';

export const TECHNICIANS_PATH = '/settings/v2/tenant/000000000/technicians';
export const BUSINESS_UNITS_PATH = '/settings/v2/tenant/000000000/business-units';
export const ROSTER_PAGE_SIZE = 500;
export const ROSTER_MAX_PAGES = 10;

export interface RosterEntry {
  id: number;
  name: string;
  businessUnitId?: number | null;
  active?: boolean;
  [key: string]: unknown;
}

export interface NameMatch {
  id: number;
  resolved: 'numeric' | 'exact' | 'prefix' | 'contains';
  ambiguous: boolean;
  candidates?: { id: number; name: string }[];
}

export interface Roster {
  rows: RosterEntry[];
  truncated: boolean;
}

export function parseNumericId(input: number | string): number | null {
  if (typeof input === 'number' && Number.isInteger(input) && input > 0) return input;
  if (typeof input === 'string' && /^\d+$/.test(input.trim())) return Number(input.trim());
  return null;
}

export async function listRoster(env: Env, ctx: ReadSTContext, path: string): Promise<Roster> {
  const result = await readSTPaged<RosterEntry>(env, ctx, path, { active: true }, {
    pageSize: ROSTER_PAGE_SIZE,
    maxPages: ROSTER_MAX_PAGES,
  });
  return {
    rows: result.rows.filter((r) => typeof r.id === 'number' && typeof r.name === 'string'),
    truncated: result.hitCap,
  };
}

export function matchByName(
  rows: readonly RosterEntry[],
  input: string,
  label: string,
  mode: 'read' | 'write' = 'read',
  truncated: boolean = false,
): NameMatch {
  const q = input.trim().toLowerCase();
  if (!q) throw new McpError('validation_error', `${label} must not be blank`);
  const tiers: Array<['exact' | 'prefix' | 'contains', (name: string) => boolean]> = [
    ['exact', (n) => n === q],
    ['prefix', (n) => n.startsWith(q)],
    ['contains', (n) => n.includes(q)],
  ];
  for (const [tier, test] of tiers) {
    const hits = rows.filter((r) => test(r.name.toLowerCase())).sort((a, b) => a.id - b.id);
    if (hits.length === 0) continue;
    const ambiguous = hits.length > 1;
    if (ambiguous && mode === 'write') {
      const preview = hits.map((h) => `${h.id}:${h.name}`).join(', ');
      throw new McpError('validation_error', `${label} ambiguous: "${input}" matches [${preview}]; pass the numeric ID instead`);
    }
    return {
      id: hits[0].id,
      resolved: tier,
      ambiguous,
      ...(ambiguous ? { candidates: hits.map((h) => ({ id: h.id, name: h.name })) } : {}),
    };
  }
  if (truncated) {
    throw new McpError(
      'validation_error',
      `${label} not found: ${input} (roster was cut off after ${rows.length} rows, so ${label} may exist beyond the cap)`,
    );
  }
  throw new McpError('validation_error', `${label} not found: ${input}`);
}

export async function resolveTechnicianLive(
  env: Env, input: number | string, ctx: ReadSTContext, mode: 'read' | 'write' = 'read',
): Promise<NameMatch> {
  const id = parseNumericId(input);
  if (id !== null) return { id, resolved: 'numeric', ambiguous: false };
  const roster = await listRoster(env, ctx, TECHNICIANS_PATH);
  return matchByName(roster.rows, String(input), 'technicianName', mode, roster.truncated);
}

export async function resolveBusinessUnitLive(
  env: Env, input: number | string, ctx: ReadSTContext, mode: 'read' | 'write' = 'read',
): Promise<NameMatch> {
  const id = parseNumericId(input);
  if (id !== null) return { id, resolved: 'numeric', ambiguous: false };
  const roster = await listRoster(env, ctx, BUSINESS_UNITS_PATH);
  return matchByName(roster.rows, String(input), 'businessUnitName', mode, roster.truncated);
}
