import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  createdOnOrAfter?: string;
  createdBefore?: string;
  modifiedOnOrAfter?: string;
  campaignId?: number;
  agentId?: number;
  phoneNumberCalled?: string;
  minDuration?: number;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawCallBody {
  id?: number;
  receivedOn?: string | null;
  createdOn?: string | null;
  duration?: string | null;
  direction?: string | null;
  callType?: string | null;
  campaign?: { id?: number } | null;
  agent?: { id?: number } | null;
  customer?: { id?: number } | null;
  businessUnit?: { id?: number } | null;
  jobNumber?: string | null;
  recordingUrl?: string | null;
  voiceMailPath?: string | null;
  modifiedOn?: string | null;
}

/** Telecom rows may carry the call fields at the top level or nested under `leadCall`. */
interface RawCallRow extends RawCallBody {
  leadCall?: RawCallBody | null;
}

/** Caller and dialled numbers are left out (PII minimisation); get_call returns them. */
interface SlimCall {
  id: number;
  received_on: string | null;
  duration: string | null;
  direction: string | null;
  call_type: string | null;
  campaign_id: number | null;
  agent_id: number | null;
  customer_id: number | null;
  business_unit_id: number | null;
  job_number: string | null;
  has_recording: boolean;
  has_voicemail: boolean;
  modified_on: string | null;
}

function slim(row: RawCallRow): SlimCall {
  const c: RawCallBody = row.leadCall ?? row;
  return {
    id: Number(c.id ?? row.id ?? 0),
    received_on: c.receivedOn ?? c.createdOn ?? null,
    duration: c.duration ?? null,
    direction: c.direction ?? null,
    call_type: c.callType ?? null,
    campaign_id: c.campaign?.id ?? null,
    agent_id: c.agent?.id ?? null,
    customer_id: c.customer?.id ?? null,
    // On the nested shape the envelope carries the booking-level business unit and job number.
    business_unit_id: row.businessUnit?.id ?? c.businessUnit?.id ?? null,
    job_number: row.jobNumber ?? c.jobNumber ?? null,
    has_recording: !!c.recordingUrl,
    has_voicemail: !!c.voiceMailPath,
    modified_on: c.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const calls_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'calls_list',
  description:
    'List phone calls (telecom v2) filtered by date window, campaign, agent, number called or minimum duration. Slim rows with has_recording / has_voicemail flags; use get_call for one call, call_recording_get for media availability. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    createdOnOrAfter: z.string().optional().describe('ISO 8601; calls received at or after this instant'),
    createdBefore: z.string().optional().describe('ISO 8601; calls received before this instant'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; calls modified at or after this instant'),
    campaignId: z.number().int().positive().optional().describe('Filter by marketing campaign ID'),
    agentId: z.number().int().positive().optional().describe('Filter by CSR / agent ID'),
    phoneNumberCalled: z.string().optional().describe('Tracking number dialled, digits only'),
    minDuration: z.number().int().nonnegative().optional().describe('Minimum call length in seconds'),
    activeOnly: z.boolean().optional().describe('ST activeOnly flag; omit for ST default'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v2/tenant/{tid}/calls', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawCallRow[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/telecom/v2/tenant/${env.ST_TENANT_ID}/calls`,
      {
        createdOnOrAfter: args.createdOnOrAfter,
        createdBefore: args.createdBefore,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        campaignId: args.campaignId,
        agentId: args.agentId,
        phoneNumberCalled: args.phoneNumberCalled,
        minDuration: args.minDuration,
        activeOnly: args.activeOnly,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawCallRow>('calls_list', rows, [
      { param: 'campaignId', want: args.campaignId, get: (r) => (r.leadCall ?? r).campaign?.id },
      { param: 'agentId', want: args.agentId, get: (r) => (r.leadCall ?? r).agent?.id },
    ], correlation);
    return {
      count: rows.length,
      calls: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
