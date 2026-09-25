import type { Env } from '../../env';
import { readSTPaged, type ReadSTContext } from '../../st';
import { codeVariants } from './code-variants';

export type CatalogKind = 'service' | 'material' | 'equipment';

export const CATALOG_PATHS: Record<CatalogKind, string> = {
  service: '/pricebook/v2/tenant/000000000/services',
  material: '/pricebook/v2/tenant/000000000/materials',
  equipment: '/pricebook/v2/tenant/000000000/equipment',
};
export const CATALOG_PAGE_SIZE = 200;
export const CATALOG_MAX_PAGES = 16;

export const PRICING_NOTE =
  'ServiceTitan can price items dynamically at invoice time; a 0 or null price here does not mean the item is free or unpriced.';

export interface CatalogRow {
  id: number;
  code?: string;
  displayName?: string;
  description?: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface CatalogScan {
  kind: CatalogKind;
  rows: CatalogRow[];
  pagesFetched: number;
  truncated: boolean;
}

export async function scanCatalog(
  env: Env,
  ctx: ReadSTContext,
  kind: CatalogKind,
  opts: { active?: boolean; searchText?: string } = {},
): Promise<CatalogScan> {
  const query: Record<string, unknown> = {};
  if (opts.active !== undefined) query.active = opts.active;
  
  
  if (opts.searchText) query.searchText = opts.searchText;
  const r = await readSTPaged<CatalogRow>(env, ctx, CATALOG_PATHS[kind], query, {
    pageSize: CATALOG_PAGE_SIZE,
    maxPages: CATALOG_MAX_PAGES,
  });
  return { kind, rows: r.rows, pagesFetched: r.pagesFetched, truncated: r.hitCap };
}

export function matchesCode(row: CatalogRow, code: string): boolean {
  if (typeof row.code !== 'string') return false;
  const wanted = new Set(codeVariants(code).map((v) => v.toUpperCase()));
  return wanted.has(row.code.trim().toUpperCase());
}

export function matchesQuery(row: CatalogRow, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const hay = [row.code, row.displayName, row.description]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function truncationWarnings(scans: readonly CatalogScan[]): string[] {
  return scans
    .filter((s) => s.truncated)
    .map((s) => `${s.kind}_scan_truncated: searched the first ${s.pagesFetched * CATALOG_PAGE_SIZE} ${s.kind} rows only; items beyond that were not searched`);
}
