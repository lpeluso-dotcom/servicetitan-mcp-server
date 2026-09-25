import { z } from 'zod';
import type { ToolDef } from '../types';
import { readST } from '../../st';
import { PROPOSAL_TEMPLATES_PATH, ESTIMATE_TEMPLATES_PATH } from '../sales/template-scan';


export const MAX_TIERS = 10;

interface Assignment {
  order?: number;
  estimateTemplateId?: number;
  proposalTypeOptionId?: number;
}
interface ProposalTemplate {
  id: number;
  name?: string;
  estimateAssignments?: Assignment[];
}
interface EstimateTemplate {
  id: number;
  name?: string;
  active?: boolean;
  items?: unknown[];
}

interface Args {
  proposalId: number;
}

export const get_proposal_tiers_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'get_proposal_tiers',
  description:
    "Return the tier ladder (for example Good/Better/Best) of a proposal template: each tier's order, " +
    'proposalTypeOptionId, estimate template id and name, item count, and active flag, in assignment order. ' +
    'Tier totals are not reported: ServiceTitan computes prices when an estimate is built (dynamic pricing). ' +
    `Capped at ${MAX_TIERS} tiers (disclosed in _warnings if hit); an unreadable estimate template on one tier ` +
    'returns null fields for that tier plus a _warnings entry rather than failing the whole call. Source: live ST ' +
    '(proposal and estimate templates).',
  zodSchema: { proposalId: z.number().int().positive().describe('Proposal template id') },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/proposal-templates/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const ctx = { actor, correlation };
    const proposal = await readST<ProposalTemplate>(env, ctx, `${PROPOSAL_TEMPLATES_PATH}/${args.proposalId}`);
    const allAssignments = [...(proposal.estimateAssignments ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const warnings: string[] = [];
    const capped = allAssignments.length > MAX_TIERS;
    const assignments = capped ? allAssignments.slice(0, MAX_TIERS) : allAssignments;
    if (capped) {
      warnings.push(
        `tiers_truncated: proposal ${args.proposalId} has ${allAssignments.length} assigned estimate templates; ` +
          `only the first ${MAX_TIERS} by order are returned`,
      );
    }

    const tiers = [];
    for (const a of assignments) {
      let template: EstimateTemplate | null = null;
      if (a.estimateTemplateId) {

        try {
          template = await readST<EstimateTemplate>(env, ctx, `${ESTIMATE_TEMPLATES_PATH}/${a.estimateTemplateId}`);
        } catch (e) {
          warnings.push(
            `estimate_template_unresolved: estimateTemplateId ${a.estimateTemplateId} could not be read ` +
              `(${e instanceof Error ? e.message : String(e)})`,
          );
        }
      }
      tiers.push({
        order: a.order ?? null,
        proposalTypeOptionId: a.proposalTypeOptionId ?? null,
        estimateTemplateId: a.estimateTemplateId ?? null,
        templateName: template?.name ?? null,
        itemCount: Array.isArray(template?.items) ? template!.items!.length : null,
        active: template?.active ?? null,
      });
    }

    return {
      proposalId: args.proposalId,
      proposalName: proposal.name ?? null,
      tiers,
      _source: 'live',
      _pricing_note:
        'Tier prices are computed by ServiceTitan when an estimate is built (dynamic pricing); this tool does not report tier totals.',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
