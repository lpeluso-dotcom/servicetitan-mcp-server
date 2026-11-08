import { z } from 'zod';
import type { ToolDef } from '../index';
import { fetchCallMediaMeta } from './call_media';

interface Args { callId: number }

export const call_voicemail_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'call_voicemail_get',
  description:
    'Check whether a call left a voicemail and report its content type and approximate size. The audio itself is NOT returned: this server has no signed-URL or binary delivery path, so listen in ServiceTitan. 404 = no media found (available:false), not an error. Source: live ST.',
  zodSchema: {
    callId: z.number().int().positive().describe('ST call ID (leadCall.id from get_call or id from calls_list)'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v2/tenant/{tid}/calls/{id}/voicemail', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    return fetchCallMediaMeta(env, { actor, correlation }, args.callId, 'voicemail');
  },
};
