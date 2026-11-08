import { z } from 'zod';
import { readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';

interface Args { windowDays: number; customerId?: number; page?: number; pageSize?: number }

// ST response fields kept. See list_memberships_active for rationale.
const ESSENTIAL_FIELDS = [
  'id', 'status', 'customerId', 'locationId', 'membershipTypeId',
  'businessUnitId', 'from', 'to', 'duration', 'billingFrequency',
  'followUpStatus', 'cancellationDate', 'nextScheduledBillDate',
] as const;

function trim(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ESSENTIAL_FIELDS) out[k] = m[k];
  return out;
}

// Semantics pinned: 'to' BETWEEN now AND now+windowDays AND status='Active'.
// Do NOT use renewedById — unreliable per local operations notes.
//
// ST's memberships endpoint has no end-date filter: activeThroughOnOrAfter /
// activeThroughBefore are not in its contract and were silently ignored, so
// the tool returned every Active membership as "expiring". The window is now
// applied here over a full scan of Active memberships, then paged locally.
const SCAN_PAGE_SIZE = 500;
const SCAN_MAX_PAGES = 20;

export const list_memberships_expiring: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_memberships_expiring',
  description: 'List active memberships whose end date (`to`) falls within the next N days, soonest first. ST cannot filter by end date, so the tool scans all Active memberships (up to 10,000; _partial if the scan hits that cap) and applies the window itself. Response is trimmed to essential fields. Source: live ST. Default page size 50, max 100 (capped to keep response under the MCP token limit).',
  zodSchema: {
    windowDays: z.number().int().positive().describe('Number of days ahead to look for expiring memberships (e.g. 30 = expiring within 30 days)'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(100).default(50).describe('Page size, max 100 (capped to keep response under MCP token limit)'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const now = Date.now();
    const windowEnd = now + args.windowDays * 24 * 60 * 60 * 1000;
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;

    // ST takes `customerIds` (plural) and silently ignores `customerId`.
    const scan = await readSTPaged<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      { status: 'Active', customerIds: args.customerId },
      { pageSize: SCAN_PAGE_SIZE, maxPages: SCAN_MAX_PAGES },
    );
    assertRowsMatchFilters('list_memberships_expiring', scan.rows, [
      { param: 'customerId', want: args.customerId, get: (m) => m.customerId },
    ], correlation);

    const endMs = (m: Record<string, unknown>) => (typeof m.to === 'string' ? Date.parse(m.to) : NaN);
    const inWindow = scan.rows
      .filter((m) => m.status === 'Active')
      .filter((m) => {
        const t = endMs(m);
        return Number.isFinite(t) && t >= now && t <= windowEnd;
      })
      .sort((a, b) => endMs(a) - endMs(b));
    const start = (page - 1) * pageSize;

    return {
      memberships: inWindow.slice(start, start + pageSize).map(trim),
      windowDays: args.windowDays,
      total_in_window: inWindow.length,
      has_more: start + pageSize < inWindow.length,
      page,
      _scanned: scan.rows.length,
      _partial: scan.hitCap ? `scan stopped at ${scan.rows.length} Active memberships; some expiring ones may be missing` : undefined,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
