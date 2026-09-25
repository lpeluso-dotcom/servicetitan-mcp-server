import { z } from 'zod';
import type { ToolDef } from '../types';
import { readST, rejectUnsupportedSTFilters } from '../../st';
import { defaultShaper } from '../../response-shape';
import { codeVariants } from '../pricebook/code-variants';
import { scanCatalog, matchesCode, truncationWarnings, PRICING_NOTE, CATALOG_PATHS, type CatalogRow } from '../pricebook/catalog-scan';

interface Args {
  code?: string;
  name?: string;
  categoryId?: number;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

interface Opts {
  name: 'search_pricebook_services' | 'search_materials';
  kind: 'service' | 'material';
  listKey: 'services' | 'materials';
  noun: string;
}

function toServiceItem(r: CatalogRow) {
  return {
    id: r.id,
    code: r.code ?? null,
    name: r.displayName ?? null,
    description: r.description ?? null,
    category_name: null,
    price: (r.price as number | null | undefined) ?? null,
    member_price: (r.memberPrice as number | null | undefined) ?? null,
    hours: (r.hours as number | null | undefined) ?? null,
    is_labor: (r.isLabor as boolean | null | undefined) ?? null,
    material_cost: null,
    active: r.active ?? null,
    cost: (r.cost as number | null | undefined) ?? null,
    use_static_prices: (r.useStaticPrices as boolean | null | undefined) ?? null,
    calculated_price: (r.calculatedPrice as number | null | undefined) ?? null,
    addon_price: (r.addOnPrice as number | null | undefined) ?? null,
    addon_member_price: (r.addOnMemberPrice as number | null | undefined) ?? null,
    taxable: (r.taxable as boolean | null | undefined) ?? null,
    account: (r.account as unknown) ?? null,
  };
}

function toMaterialItem(r: CatalogRow) {
  return {
    id: r.id,
    code: r.code ?? null,
    name: r.displayName ?? null,
    description: r.description ?? null,
    category_name: null,
    price: (r.price as number | null | undefined) ?? null,
    member_price: (r.memberPrice as number | null | undefined) ?? null,
    cost: (r.cost as number | null | undefined) ?? null,
    active: r.active ?? null,
    unit_of_measure: (r.unitOfMeasure as string | null | undefined) ?? null,
    taxable: (r.taxable as boolean | null | undefined) ?? null,
    account: (r.account as unknown) ?? null,
    primary_vendor_name: null,
    primary_vendor_id: null,
    is_inventory: (r.isInventory as boolean | null | undefined) ?? null,
  };
}

function toItem(kind: 'service' | 'material', r: CatalogRow) {
  return kind === 'service' ? toServiceItem(r) : toMaterialItem(r);
}

export function makePricebookCodeSearch(opts: Opts): ToolDef<Args> {
  const endpoint = CATALOG_PATHS[opts.kind];
  const templatedEndpoint = endpoint.replace('000000000', '{tid}');
  return {
    isWrite: false,
    permission: 'staff',
    name: opts.name,
    description:
      `Look up pricebook ${opts.listKey} by exact \`code\` (tries raw, UPPERCASE, and UPPERCASE-hyphenated variants) or list ` +
      `them one page at a time with active/page/pageSize. ServiceTitan has no name or category filter here, so name and ` +
      `categoryId are refused; use search_pricebook_all({query}) for word matching. A code hit's item has the same keys as ` +
      `this tool's own catalog lookup; any key ServiceTitan's live pricebook list endpoint has no equivalent field for ` +
      `(e.g. category_name) is null, not absent. Code lookup scans up to 3,200 rows and reports a truncated scan in ` +
      `_warnings. Price 0/null does not mean free or unpriced — ServiceTitan prices dynamically. Source: live ST. Default page size 50, max 200.`,
    zodSchema: {
      code: z.string().min(1).max(64).optional().describe(`Exact ${opts.noun} code (e.g. "WHEH-140").`),
      name: z.string().optional().describe('NOT SUPPORTED by ServiceTitan on this endpoint; returns a validation error. Use search_pricebook_all({query}).'),
      categoryId: z.number().int().positive().optional().describe('NOT SUPPORTED by ServiceTitan on this endpoint; returns a validation error.'),
      active: z.boolean().optional().describe('Filter the page listing by active status (default: all)'),
      page: z.number().int().positive().default(1).describe('Page number'),
      pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
    },
    stEndpoint: { method: 'GET', path: templatedEndpoint, source: 'live' },
    async handler(env, args, { actor, correlation }) {
      rejectUnsupportedSTFilters(
        args as unknown as Record<string, unknown>,
        {
          name: `ServiceTitan has no name filter on ${templatedEndpoint}. Use search_pricebook_all({query}), or pass code for an exact lookup.`,
          categoryId: `ServiceTitan has no categoryId filter on ${templatedEndpoint}. Page the catalogue and filter client-side.`,
        },
        correlation,
      );
      const ctx = { actor, correlation };
      if (args.code) {
        const scan = await scanCatalog(env, ctx, opts.kind);
        const hits = scan.rows.filter((r) => matchesCode(r, args.code!));
        const warnings = truncationWarnings([scan]);
        return {
          [opts.listKey]: hits.map((r) => toItem(opts.kind, r)),
          _source: 'live-scan',
          
          
          _matched_code: hits.length > 0 ? args.code : null,
          ...(hits.length === 0
            ? { _note: `No pricebook ${opts.noun} found with code "${args.code}". Tried variants: ${codeVariants(args.code).join(', ')}. For word matching use search_pricebook_all({query}).` }
            : {}),
          _pricing_note: PRICING_NOTE,
          ...(warnings.length > 0 ? { _warnings: warnings } : {}),
        };
      }
      const page = args.page ?? 1;
      const pageSize = args.pageSize ?? 50;
      const data = await readST<{ data?: unknown[]; hasMore?: boolean }>(env, ctx, endpoint, { active: args.active, page, pageSize });
      return { [opts.listKey]: data.data ?? [], page, pageSize, has_more: data.hasMore === true, _source: 'live', _pricing_note: PRICING_NOTE };
    },
    transformResult: defaultShaper,
  };
}

export const search_pricebook_services_public = makePricebookCodeSearch({
  name: 'search_pricebook_services', kind: 'service', listKey: 'services', noun: 'service',
});

export const search_materials_public = makePricebookCodeSearch({
  name: 'search_materials', kind: 'material', listKey: 'materials', noun: 'material',
});
