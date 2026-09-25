import { z } from 'zod';
import type { ToolDef } from '../types';
import { scanTemplates, templateMatches, TEMPLATE_MAX_PAGES, TEMPLATE_PAGE_SIZE } from '../sales/template-scan';

interface Args { query: string; limit?: number }

export const search_pricebook_templates_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'search_pricebook_templates',
  description:
    'Find estimate templates and proposal templates whose name, internal name, or summary contains every word of query. ' +
    'Returns kind, id, name, and active for each match (active and inactive). Use get_estimate_template or ' +
    'get_proposal_tiers for details. Scans up to 1,000 templates of each kind and reports a truncated scan in _warnings. ' +
    'Source: live ST. Default limit 12, max 25.',
  zodSchema: {
    query: z.string().min(1).max(300).describe('Template or proposal name words'),
    limit: z.number().int().min(1).max(25).default(12).optional().describe('Max results (default 12, max 25)'),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimate-templates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const ctx = { actor, correlation };
    const scans = [await scanTemplates(env, ctx, 'estimate_template'), await scanTemplates(env, ctx, 'proposal_template')];
    const all = scans.flatMap((s) =>
      s.rows.filter((r) => templateMatches(r, args.query)).map((r) => ({ kind: s.kind, id: r.id, name: r.name ?? null, active: r.active ?? null })),
    );
    const results = all.slice(0, args.limit ?? 12);
    const warnings = scans
      .filter((s) => s.truncated)
      .map((s) => `${s.kind}_scan_truncated: searched the first ${TEMPLATE_MAX_PAGES * TEMPLATE_PAGE_SIZE} ${s.kind}s only`);
    return {
      results,
      count: results.length,
      total_matches: all.length,
      _source: 'live-scan',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
