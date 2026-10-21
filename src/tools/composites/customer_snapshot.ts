import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetchesWithTruncation, stReadGuarded } from './composite-helpers';
import type { ToolDef } from '../types';
import { PUBLIC_TENANT_ID_PLACEHOLDER } from '../../tenant';
import { excludeFields, limitArrays } from '../../response-shape';

interface Args { customerId: number }

// Fires 6 parallel reads. Nothing is cached: a failed or truncated arm is
// retried on the next call, so a partial snapshot is never served as fresh.
export const customer_snapshot: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'customer_snapshot',
  description: 'Composite: returns a full customer snapshot (customer details, locations, jobs, memberships, estimates, and invoices) in a single call. Reads six ServiceTitan endpoints in parallel. If one read fails, the rest still return: `_partial` is true and `_failures` names the failed section, whose value is null. `_truncated` names any section ServiceTitan reported more pages for (page one only). Source: live ST.',
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers/{id}', source: 'live' },
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
  },
  // Every fanout payload is z.unknown() on purpose: a sub-result is null on
  // partial failure, and each success shape is a raw ST resource (object) or
  // list (array) depending on the endpoint. A strict type here would reject
  // exactly the partial-failure case this composite exists to report.
  // transformResult (limitArrays + excludeFields) may also add
  // `${key}_truncated` keys, which the default (non-strict) object schema
  // tolerates without declaring them.
  outputSchema: {
    customerId: z.number(),
    customer: z.unknown().optional(),
    locations: z.unknown().optional(),
    jobs: z.unknown().optional(),
    memberships: z.unknown().optional(),
    estimates: z.unknown().optional(),
    invoices: z.unknown().optional(),
    _partial: z.boolean().optional(),
    _failures: z.array(z.unknown()).optional(),
    _truncated: z.array(z.string()).optional(),
    _composite: z.string().optional(),
    _source: z.string().optional(),
    correlation: z.string().optional(),
  },
  async handler(env, args, { actor, correlation }) {
    const { customerId } = args;
    const h = authHeaders(env, correlation, actor);
    const tenant = PUBLIC_TENANT_ID_PLACEHOLDER;
    const signal = AbortSignal.timeout(15_000);

    const fanout = await gatherFetchesWithTruncation([
      { name: 'customer',    promise: stReadGuarded(env, h, `/crm/v2/tenant/${tenant}/customers/${customerId}`, signal) },
      { name: 'locations',   promise: stReadGuarded(env, h, `/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`, signal) },
      { name: 'jobs',        promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`, signal) },
      { name: 'memberships', promise: stReadGuarded(env, h, `/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&status=Active`, signal) },
      { name: 'estimates',   promise: stReadGuarded(env, h, `/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`, signal) },
      { name: 'invoices',    promise: stReadGuarded(env, h, `/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`, signal) },
    ]);

    // Memberships need a client-side re-filter: ServiceTitan's status filter is unreliable.
    const membershipsRaw = fanout.results.memberships;
    const memberships = Array.isArray(membershipsRaw)
      ? (membershipsRaw as Record<string, unknown>[]).filter((m) => m.status === 'Active')
      : membershipsRaw;

    return {
      customerId,
      _partial: fanout.partial,
      _failures: fanout.failures,
      customer: fanout.results.customer,
      locations: fanout.results.locations,
      jobs: fanout.results.jobs,
      memberships,
      estimates: fanout.results.estimates,
      invoices: fanout.results.invoices,
      // Name every list section ServiceTitan reported more pages for, so a
      // page-one answer is disclosed instead of served as the whole set.
      _truncated: fanout.truncated,
      _composite: 'customer_snapshot',
      _source: 'live',
      correlation,
    };
  },
  transformResult: (r) => limitArrays(excludeFields(r as Record<string, unknown>), {
    jobs: 25,
    invoices: 25,
    estimates: 25,
    locations: 10,
  }),
};
