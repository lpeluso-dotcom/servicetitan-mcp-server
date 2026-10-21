// ServiceTitan has no generic PATCH for technician assignment. Replacing the
// assigned set is a two-call compound: unassign-technicians, then
// assign-technicians. Both calls appear in the dryRun preview payload.
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { guardedStFetch } from '../../rate-limit-guard';
import { backendWrite } from '../../backend';
import { rewriteTenantPlaceholders } from '../../tenant';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

interface Args { appointmentId: number; technicianIds: number[]; dryRun?: boolean; confirmation_token?: string }

const UNASSIGN_ENDPOINT = '/dispatch/v2/tenant/000000000/appointment-assignments/unassign-technicians';
const ASSIGN_ENDPOINT = '/dispatch/v2/tenant/000000000/appointment-assignments/assign-technicians';

async function postStep(
  env: Env,
  endpoint: string,
  payload: unknown,
  label: string,
  actor: string,
  correlation: string,
): Promise<Response> {
  const resp = await guardedStFetch(env, endpoint, () =>
    backendWrite(env, { endpoint, method: 'POST', payload }, {
      headers: { 'content-type': 'application/json', 'x-correlation-id': correlation, 'x-actor': actor },
    })
  );
  if (!resp.ok) {
    throw new McpError('upstream_error', `assign_technicians: ${label} step failed: ${resp.status}`, { correlation });
  }
  return resp;
}

export const assign_technicians: ToolDef<Args> = {
  permission: 'staff',
  name: 'assign_technicians',
  description: 'Assign technicians to an appointment. ST requires a two-call compound: unassign all current techs, then assign the new set. Both calls are shown in the dryRun preview. dryRun=true (default) → token → dryRun=false to write. Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/dispatch/v2/tenant/{tid}/appointment-assignments/assign-technicians', source: 'live' },
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    technicianIds: z.array(z.number().int().positive()).min(1).describe('Technician IDs to assign (replaces current assignment)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { appointmentId, technicianIds, dryRun = true, confirmation_token } = args;
    const businessArgs = { appointmentId, technicianIds };
    const gate = new WriteGate(env);
    const unassignEndpoint = rewriteTenantPlaceholders(env, UNASSIGN_ENDPOINT);
    const assignEndpoint = rewriteTenantPlaceholders(env, ASSIGN_ENDPOINT);

    if (dryRun) {
      const compoundPayload = {
        steps: [
          { call: 1, endpoint: unassignEndpoint, method: 'POST', payload: { appointmentId } },
          { call: 2, endpoint: assignEndpoint, method: 'POST', payload: { appointmentId, technicianIds } },
        ],
      };
      return gate.dryRun('assign_technicians', businessArgs, actor, correlation, compoundPayload,
        '/dispatch/v2/tenant/000000000/appointment-assignments', 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('assign_technicians', businessArgs, actor, confirmation_token);

    await postStep(env, unassignEndpoint, { appointmentId }, 'unassign', actor, correlation);
    const assignResp = await postStep(env, assignEndpoint, { appointmentId, technicianIds }, 'assign', actor, correlation);

    return { dryRun: false, tool: 'assign_technicians', result: await assignResp.json(), correlation };
  },
};
