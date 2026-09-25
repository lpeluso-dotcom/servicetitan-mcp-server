import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  templateId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const delete_estimate_template = defineWriteTool<Args>({
  name: 'delete_estimate_template',
  description:
    'Soft-deactivates an estimate template (sets active=false) — reversible via ' +
    'update_estimate_template({templateId, active:true}). This is NOT a hard delete. ' +
    'Note: DELETE advances modifiedOn (unlike an item-level PATCH via update_estimate_template, which freezes it). ' +
    'dryRun=true (default) → token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
  },
  endpoint: ({ templateId }) => `/sales/v2/tenant/000000000/estimate-templates/${templateId}`,
  method: 'DELETE',
  payload: () => ({}),
  businessArgs: ({ templateId }) => ({ templateId }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
});
