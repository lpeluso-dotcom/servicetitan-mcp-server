import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';
import { PROPOSAL_TEMPLATES_PATH } from './template-scan';
import { CATEGORY_IDS_UNSUPPORTED } from './create_proposal_template';

const Assignment = z.object({
  order: z.number().int().positive(),
  estimateTemplateId: z.number().int().positive(),
  proposalTypeOptionId: z.number().int().positive(),
});

const FIELDS = ['name', 'description', 'businessUnitIds', 'estimateAssignments', 'active'] as const;

interface Args {
  templateId: number;
  name?: string;
  description?: string;
  businessUnitIds?: number[];
  estimateAssignments?: Array<z.infer<typeof Assignment>>;
  active?: boolean;
  categoryIds?: number[];
  dryRun?: boolean;
  confirmation_token?: string;
}

function patch(args: Args): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (args[f] !== undefined) out[f] = args[f];
  return out;
}

export const update_proposal_template = defineWriteTool<Args>({
  name: 'update_proposal_template',
  description:
    'Update a proposal template. Only the fields you pass are changed; estimateAssignments, when given, replaces the whole ' +
    'tier list. categoryIds is refused (the public API silently drops it). Verify the write with get_proposal_tiers (tier ' +
    'order, proposalTypeOptionId, and each tier\'s estimate template id/name/item count/active) or ' +
    'search_pricebook_templates (name and active, by searching); neither live tool surfaces description or businessUnitIds. ' +
    'dryRun=true (default) → confirmation_token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    templateId: z.number().int().positive().describe('Proposal template id'),
    name: z.string().min(1).max(255).optional().describe('New name (must stay unique)'),
    description: z.string().optional().describe('Customer-facing description'),
    businessUnitIds: z.array(z.number().int().positive()).min(1).optional().describe('Replaces the business-unit list'),
    estimateAssignments: z.array(Assignment).min(1).max(10).optional().describe('Replaces the whole tier list'),
    active: z.boolean().optional().describe('Active flag'),
    categoryIds: z.array(z.number().int().positive()).optional().describe('NOT SUPPORTED by the public API; returns a validation error.'),
  },
  validate: (args) => {
    if (args.categoryIds !== undefined) throw new Error(CATEGORY_IDS_UNSUPPORTED);
    if (Object.keys(patch(args)).length === 0) throw new Error(`pass at least one of: ${FIELDS.join(', ')}`);
  },
  endpoint: ({ templateId }) => `${PROPOSAL_TEMPLATES_PATH}/${templateId}`,
  method: 'PATCH',
  payload: patch,
  businessArgs: (args) => ({ templateId: args.templateId, ...patch(args) }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/proposal-templates/{templateId}',
});
