import { z } from 'zod';
import { McpError } from '../../errors';
import { readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  formId: number;
  submissionId: number;
}

// ServiceTitan has no per-submission route, and the submissions list silently
// ignores its `ids` filter (even combined with `formIds`). `formIds` is the only
// filter it honors, so the lookup scans one form's submissions for the id.
export const get_form_submission: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_form_submission',
  description:
    'Get a form submission record by id. Source: live ServiceTitan. ' +
    'ServiceTitan has no per-ID route for submissions, and the submissions list silently ignores its `ids` filter, ' +
    'so this lookup scans one form\'s submissions (paged, filtered by `formIds`) until it finds the submission id. ' +
    'Both `formId` and `submissionId` are required; a bare submission id cannot be resolved. ' +
    'Large forms take several requests. Note: form submissions return unit IDs, not equipment IDs.',
  zodSchema: {
    formId: z.number().int().positive().describe('ServiceTitan form ID whose submissions are scanned'),
    submissionId: z.number().int().positive().describe('ServiceTitan form submission ID to find'),
  },
  stEndpoint: { method: 'GET', path: '/forms/v2/tenant/{tid}/submissions', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { rows, hitCap } = await readSTPaged<Record<string, unknown>>(
      env,
      { actor, correlation },
      '/forms/v2/tenant/000000000/submissions',
      { formIds: args.formId },
      { pageSize: 200 },
    );
    const match = rows.find((r) => Number((r as { id?: unknown }).id) === args.submissionId);
    if (!match) {
      throw new McpError(
        'not_found',
        `form submission ${args.submissionId} not found in the scan of form ${args.formId}'s submissions` +
          (hitCap
            ? ` (the scan stopped at the page cap, so the form has more submissions that were not scanned)`
            : ''),
        { correlation },
      );
    }
    return { submission: match, _source: 'live' };
  },
  transformResult: defaultShaper,
};
