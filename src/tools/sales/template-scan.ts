import type { Env } from '../../env';
import { readSTPaged, type ReadSTContext } from '../../st';

export const ESTIMATE_TEMPLATES_PATH = '/sales/v2/tenant/000000000/estimate-templates';
export const PROPOSAL_TEMPLATES_PATH = '/sales/v2/tenant/000000000/proposal-templates';
export const TEMPLATE_PAGE_SIZE = 50;
export const TEMPLATE_MAX_PAGES = 20;

export interface TemplateRow {
  id: number;
  name?: string;
  internalName?: string;
  summary?: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface TemplateScan {
  kind: 'estimate_template' | 'proposal_template';
  rows: TemplateRow[];
  truncated: boolean;
}

export async function scanTemplates(env: Env, ctx: ReadSTContext, kind: TemplateScan['kind']): Promise<TemplateScan> {
  const path = kind === 'estimate_template' ? ESTIMATE_TEMPLATES_PATH : PROPOSAL_TEMPLATES_PATH;
  const r = await readSTPaged<TemplateRow>(env, ctx, path, { active: 'Any' }, {
    pageSize: TEMPLATE_PAGE_SIZE,
    maxPages: TEMPLATE_MAX_PAGES,
  });
  return { kind, rows: r.rows, truncated: r.hitCap };
}

export function templateMatches(row: TemplateRow, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const hay = [row.name, row.internalName, row.summary]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
