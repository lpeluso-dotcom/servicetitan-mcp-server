// ServiceTitan silently ignores unknown query params and returns an
// unfiltered page with HTTP 200. When a filter's value is echoed on each
// returned row, check every row against it and fail loudly instead of
// handing the model someone else's records.
import { McpError } from '../errors';

export interface FilterCheck<R> {
  /** Tool-facing filter name, used in the error message. */
  param: string;
  /** Requested value; undefined = filter not set (skipped). An array is a set: the row value must be in it. */
  want: unknown;
  /** Value read from the RAW ST row. null/undefined/empty array = not comparable (skipped). An array passes if any member is in the set. */
  get: (row: R) => unknown;
}

function norm(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return /^-?\d+$/.test(t) ? String(Number(t)) : t.toLowerCase();
  }
  return String(v);
}

export function assertRowsMatchFilters<R>(
  tool: string,
  rows: readonly R[],
  checks: ReadonlyArray<FilterCheck<R>>,
  correlation: string,
): void {
  for (const check of checks) {
    if (check.want === undefined || check.want === null) continue;
    const wantList = Array.isArray(check.want) ? check.want : [check.want];
    if (wantList.length === 0) continue;
    const want = new Set(wantList.map(norm));
    for (const row of rows) {
      const raw = check.get(row);
      if (raw === undefined || raw === null) continue;
      const got = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined && v !== null);
      if (got.length === 0) continue;
      if (got.some((v) => want.has(norm(v)))) continue;
      const id = (row as { id?: unknown })?.id;
      throw new McpError(
        'upstream_error',
        `${tool}: ST ignored the ${check.param} filter (asked ${wantList.join(',')}, row ${String(id)} has ${got.join(',')})`,
        { correlation },
      );
    }
  }
}
