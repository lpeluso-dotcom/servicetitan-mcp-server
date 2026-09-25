import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';
import { PROPOSAL_TEMPLATES_PATH } from './template-scan';

export const CATEGORY_IDS_UNSUPPORTED =
  'categoryIds cannot be set through the public ServiceTitan API (it is accepted and silently dropped). ' +
  'Set proposal categories in the ServiceTitan UI after saving the template.';

const Assignment = z.object({
  order: z.number().int().positive().describe('Tier position, 1 = first'),
  estimateTemplateId: z.number().int().positive().describe('Estimate template for this tier'),
  proposalTypeOptionId: z.number().int().positive().describe('Proposal type option (tier slot) id'),
});

interface Args {
  name: string;
  description?: string;
  proposalTypeId: number;
  businessUnitIds: number[];
  estimateAssignments: Array<z.infer<typeof Assignment>>;
  active?: boolean;
  categoryIds?: number[];
  dryRun?: boolean;
  confirmation_token?: string;
}

function body(args: Args): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: args.name,
    proposalTypeId: args.proposalTypeId,
    businessUnitIds: args.businessUnitIds,
    estimateAssignments: args.estimateAssignments,
  };
  if (args.description !== undefined) out.description = args.description;
  if (args.active !== undefined) out.active = args.active;
  return out;
}

export const create_proposal_template = defineWriteTool<Args>({
  name: 'create_proposal_template',
  description:
    'Create a proposal template (a tiered set of estimate templates, for example Good/Better/Best). ' +
    'categoryIds is refused because the public API silently drops it; set categories in the ServiceTitan UI afterwards. ' +
    'Verify the write with get_proposal_tiers (tier order, proposalTypeOptionId, and each tier\'s estimate template id/' +
    'name/item count/active) or search_pricebook_templates (name and active, by searching); neither live tool surfaces ' +
    'description or businessUnitIds. dryRun=true (default) → confirmation_token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    name: z.string().min(1).max(255).describe('Template name (unique in ServiceTitan)'),
    description: z.string().optional().describe('Customer-facing description'),
    proposalTypeId: z.number().int().positive().describe('Proposal type id'),
    businessUnitIds: z.array(z.number().int().positive()).min(1).describe('Business units that can use this template'),
    estimateAssignments: z.array(Assignment).min(1).max(10).describe('One entry per tier'),
    active: z.boolean().optional().describe('Active flag (ServiceTitan default when omitted)'),
    categoryIds: z.array(z.number().int().positive()).optional().describe('NOT SUPPORTED by the public API; returns a validation error.'),
  },
  validate: (args) => {
    if (args.categoryIds !== undefined) throw new Error(CATEGORY_IDS_UNSUPPORTED);
  },
  endpoint: () => PROPOSAL_TEMPLATES_PATH,
  method: 'POST',
  payload: body,
  businessArgs: body,
  stEndpointTemplate: '/sales/v2/tenant/{tid}/proposal-templates',
});
