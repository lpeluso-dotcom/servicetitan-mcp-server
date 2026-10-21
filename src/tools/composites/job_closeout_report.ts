import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetchesWithTruncation, stReadGuarded } from './composite-helpers';
import type { ToolDef } from '../types';
import { PUBLIC_TENANT_ID_PLACEHOLDER } from '../../tenant';
import { defaultShaper } from '../../response-shape';

interface Args { jobId: number }

export const job_closeout_report: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'job_closeout_report',
  description: 'Composite: job closeout rollup of job details, appointments, and invoices, read from ServiceTitan in parallel. A job is 1:N invoices (base + adjustments): `invoices[]` holds the invoices returned with `_invoice_count`, and `_truncated` lists any section ServiceTitan reported more pages for (when it includes "invoices", the list is page one only, so `_invoice_count` is a lower bound). `invoice` is the first, for back-compat only. If one read fails, the rest still return: `_partial` is true and `_failures` names the failed section, whose value is null. Form submissions are not included; use get_form_submission. Source: live ST. Portions duplicate `st_run_report` (mode=run).',
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs/{id}', source: 'live' },
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { jobId } = args;
    const h = authHeaders(env, correlation, actor);
    const tenant = PUBLIC_TENANT_ID_PLACEHOLDER;

    const fanout = await gatherFetchesWithTruncation([
      { name: 'job',          promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/jobs/${jobId}`) },
      { name: 'appointments', promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/appointments?jobId=${jobId}`) },
      { name: 'invoices',     promise: stReadGuarded(env, h, `/accounting/v2/tenant/${tenant}/invoices?jobId=${jobId}`) },
    ]);

    // A job's invoices are 1:N (base + adjustments). Preserve the full array
    // and its count; keep `invoice` (the first) for back-compat, but do not
    // present it as the whole closeout.
    const invoiceData = fanout.results.invoices;
    const invoices = Array.isArray(invoiceData) ? invoiceData : invoiceData != null ? [invoiceData] : [];
    const firstInvoice = invoices[0] ?? null;

    return {
      jobId,
      _partial: fanout.partial,
      _failures: fanout.failures,
      _truncated: fanout.truncated,
      job: fanout.results.job,
      appointments: fanout.results.appointments,
      invoice: firstInvoice,
      invoices,
      _invoice_count: invoices.length,
      _composite: 'job_closeout_report',
      _source: 'live',
      _note: 'form submissions are available via get_form_submission',
      correlation,
    };
  },
  transformResult: defaultShaper,
};
