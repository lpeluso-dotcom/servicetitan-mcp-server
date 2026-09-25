import { z } from 'zod';
import type { ToolDef } from '../types';
import { McpError } from '../../errors';
import {
  scanCatalog, matchesCode, matchesQuery, truncationWarnings, PRICING_NOTE, CATALOG_MAX_PAGES,
  type CatalogKind, type CatalogRow, type CatalogScan,
} from '../pricebook/catalog-scan';
import { codeVariants } from '../pricebook/code-variants';
import { currentBudget } from '../../request-budget';

const RESULT_LIMIT = 8;
const KINDS: readonly CatalogKind[] = ['service', 'material', 'equipment'];


const REQUEST_UPSTREAM_CAP = 100;

export function fallbackFitsBudget(
  budget: { upstream: number } | undefined,
  worstCaseCalls: number,
  cap: number = REQUEST_UPSTREAM_CAP,
): boolean {
  if (!budget) return true;
  return budget.upstream + worstCaseCalls <= cap;
}

interface Args { code?: string; query?: string }

function matchedCodeVariant(code: string, items: ReadonlyArray<{ code: string | null }>): string | null {
  for (const variant of codeVariants(code)) {
    const wanted = variant.toUpperCase();
    if (items.some((it) => typeof it.code === 'string' && it.code.trim().toUpperCase() === wanted)) {
      return variant;
    }
  }
  return null;
}

function toItem(kind: CatalogKind, r: CatalogRow) {
  const price = (r.price as number | null | undefined) ?? null;
  const calculatedPrice = kind === 'service' ? ((r.calculatedPrice as number | null | undefined) ?? null) : null;
  return {
    type: kind,
    id: r.id,
    code: r.code ?? null,
    name: r.displayName ?? null,
    description: r.description ?? null,
    category: null,
    price,
    member_price: (r.memberPrice as number | null | undefined) ?? null,
    hours: kind === 'material' ? null : ((r.hours as number | null | undefined) ?? null),
    calculated_price: calculatedPrice,
    pricing: kind === 'service' ? (calculatedPrice != null ? 'dynamic' : (price ? 'static' : 'dynamic-unknown')) : null,
  };
}

export const search_pricebook_all_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'search_pricebook_all',
  description:
    'Search the ServiceTitan pricebook across services, materials, and equipment. Use code for an exact code lookup ' +
    '(tries the raw value, UPPERCASE, and UPPERCASE-hyphenated, so "flu150" finds FLU-150; code wins if both code and ' +
    'query are given) or query to match every word against code, name, and description. On a query search, matching ' +
    'tries ServiceTitan\'s own text search first as a narrowing hint, then falls back to a full bounded scan if that ' +
    'finds nothing (ST\'s text search may cover fewer fields than this tool\'s matcher) — every candidate row is always ' +
    're-checked here regardless of which scan found it. Results found through ServiceTitan\'s text search may leave ' +
    'out items that match only on fields that search doesn\'t cover; for an exhaustive check, search by code or ' +
    'narrow the query. Returns up to 8 active items with a type discriminator and ' +
    'hours (decimal labor hours; null for materials). category and calculated_price are null in this build — ' +
    'ServiceTitan\'s live pricebook list has no confirmed single category-name field, and only services expose a live ' +
    'calculatedPrice; pricing is dynamic/static/dynamic-unknown on services (from calculatedPrice) and null on ' +
    'materials/equipment (no live signal). ServiceTitan has no name/code filter on these endpoints, so this scans up ' +
    'to 3,200 rows per type and reports a truncated scan in _warnings. Price 0/null does not mean free or unpriced ' +
    '(dynamic pricing). Source: live ST.',
  zodSchema: {
    code: z.string().min(1).max(64).optional().describe('Exact pricebook code (e.g. "HUM-120"). Wins over query if both are given.'),
    query: z.string().min(1).max(100).optional().describe('Words to match against code, name, and description (all must match).'),
  },

  outputSchema: {
    status: z.string(),
    count: z.number(),
    total_matches: z.number(),
    items: z.array(z.record(z.string(), z.unknown())),
    matched_code: z.string().optional(),
    message: z.string().optional(),
    _source: z.string(),
    _pricing_note: z.string(),
    _warnings: z.array(z.string()).optional(),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (!args.code && !args.query) {
      throw new McpError('validation_error', 'pass code or query', { correlation });
    }
    const ctx = { actor, correlation };
    const predicate = args.code ? (r: CatalogRow) => matchesCode(r, args.code!) : (r: CatalogRow) => matchesQuery(r, args.query!);

    const scanAll = async (searchText: string | undefined): Promise<CatalogScan[]> => {
      const opts = { active: true, ...(searchText ? { searchText } : {}) };
      const out: CatalogScan[] = [];
      for (const kind of KINDS) out.push(await scanCatalog(env, ctx, kind, opts));
      return out;
    };
    const matchAll = (scans: CatalogScan[]) =>
      scans.flatMap((s) => s.rows.filter(predicate).map((r) => toItem(s.kind, r)));

    const useSearchTextHint = !args.code && !!args.query;
    let scans = await scanAll(useSearchTextHint ? args.query : undefined);
    let all = matchAll(scans);

    const narrowedHadHits = useSearchTextHint && all.length > 0;

    let fallbackSkippedForBudget = false;
    if (useSearchTextHint && all.length === 0) {
      const fallbackWorstCase = KINDS.length * CATALOG_MAX_PAGES;
      if (fallbackFitsBudget(currentBudget(), fallbackWorstCase)) {
        scans = await scanAll(undefined);
        all = matchAll(scans);
      } else {
        fallbackSkippedForBudget = true;
      }
    }

    const items = all.slice(0, RESULT_LIMIT);
    const warnings = truncationWarnings(scans);
    if (narrowedHadHits) {
      warnings.push(
        'text_search_narrowed: matched via ServiceTitan\'s text search, which may not cover every field — search by code or narrow the query for an exhaustive check.',
      );
    }
    if (fallbackSkippedForBudget) {
      warnings.push(
        'budget_fallback_skipped: the request\'s upstream-call budget did not have enough room left for the full-scan ' +
          'fallback after ServiceTitan\'s text search found nothing — results may be incomplete. Narrow the query or search by code.',
      );
    }

    if (items.length === 0) {
      const message = args.code
        ? `No pricebook item with code "${args.code}" (also tried ${codeVariants(args.code).slice(1).join(', ')}).`
        : `Nothing found for "${args.query}". Try a different term.`;
      return {
        status: 'not_found',
        count: 0,
        total_matches: 0,
        items,
        message,
        _source: 'live-scan',
        _pricing_note: PRICING_NOTE,
        ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      };
    }

    return {
      status: 'success',
      count: items.length,
      total_matches: all.length,
      items,
      ...(args.code ? { matched_code: matchedCodeVariant(args.code, items) ?? args.code } : {}),
      _source: 'live-scan',
      _pricing_note: PRICING_NOTE,
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
