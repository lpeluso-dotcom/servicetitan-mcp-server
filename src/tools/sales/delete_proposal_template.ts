import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';
import { PROPOSAL_TEMPLATES_PATH } from './template-scan';

interface Args {
  templateId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const delete_proposal_template = defineWriteTool<Args>({
  name: 'delete_proposal_template',
  description:
    'Delete a proposal template. This DEACTIVATES the template (sets active=false); it does not permanently remove it, ' +
    'and can be reactivated with update_proposal_template({templateId, active:true}). ' +
    'dryRun=true (default) → confirmation_token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    templateId: z.number().int().positive().describe('Proposal template id'),
  },
  endpoint: ({ templateId }) => `${PROPOSAL_TEMPLATES_PATH}/${templateId}`,
  method: 'DELETE',
  payload: () => ({}),
  businessArgs: ({ templateId }) => ({ templateId }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/proposal-templates/{templateId}',
});
