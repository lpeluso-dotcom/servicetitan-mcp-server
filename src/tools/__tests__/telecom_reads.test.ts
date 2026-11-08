import { describe, it, expect, vi } from 'vitest';
import { calls_list } from '../telecom/calls_list';
import { call_recording_get } from '../telecom/call_recording_get';
import { call_voicemail_get } from '../telecom/call_voicemail_get';
import { fetchCallMediaMeta } from '../telecom/call_media';
import { expectCalledPathMatchesDeclared } from './declared_path_helper';

const CTX = { actor: 'test', correlation: 'c1' };
function envWith(response: Response | (() => Response)) {
  const make = typeof response === 'function' ? response : () => response;
  return {
    ST_TENANT_ID: '000000000',
    ST_TRANSPORT: { fetch: vi.fn(async () => make()) },
    MCP_SYNC_KEY: 'k',
  } as any;
}
const jsonEnv = (body: unknown, status = 200) => envWith(() => new Response(JSON.stringify(body), { status }));
const calledUrl = (env: any): string => String(env.ST_TRANSPORT.fetch.mock.calls[0][0]);
const calledInit = (env: any) => env.ST_TRANSPORT.fetch.mock.calls[0][1];

const FLAT_CALL = {
  id: 4001, receivedOn: '2026-03-01T10:00:00Z', duration: '00:04:10', from: '8435550100', to: '8435550199', direction: 'Inbound',
  callType: 'Booked', campaign: { id: 9, name: 'Google LSA' }, agent: { id: 55, name: 'CSR One' }, customer: { id: 301 },
  businessUnit: { id: 12 }, jobNumber: '99001', recordingUrl: 'https://api.servicetitan.io/x/recording', voiceMailPath: null, modifiedOn: '2026-03-01T10:05:00Z',
};
const NESTED_CALL = { id: 0, jobNumber: '99002', businessUnit: { id: 13 }, leadCall: { ...FLAT_CALL, id: 4002, jobNumber: undefined } };

describe('calls_list', () => {
  it('forwards filters to telecom v2 and slims flat and leadCall-nested rows', async () => {
    const env = jsonEnv({ data: [FLAT_CALL, NESTED_CALL], hasMore: false, totalCount: 2 });
    const out = (await calls_list.handler(
      env, { createdOnOrAfter: '2026-03-01T00:00:00Z', modifiedOnOrAfter: '2026-03-01T00:00:00Z', campaignId: 9, agentId: 55, phoneNumberCalled: '8435550199', minDuration: 30, activeOnly: true, includeTotal: true }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Ftelecom%2Fv2%2Ftenant%2F000000000%2Fcalls');
    expect(url).not.toContain('%2Ftelecom%2Fv3');
    for (const p of ['createdOnOrAfter%3D2026-03-01', 'modifiedOnOrAfter%3D2026-03-01', 'campaignId%3D9', 'agentId%3D55', 'phoneNumberCalled%3D8435550199', 'minDuration%3D30', 'activeOnly%3Dtrue', 'includeTotal%3Dtrue']) {
      expect(url).toContain(p);
    }
    expectCalledPathMatchesDeclared(calls_list, url, calledInit(env));
    expect(out.calls[0]).toEqual({
      id: 4001, received_on: '2026-03-01T10:00:00Z', duration: '00:04:10', direction: 'Inbound', call_type: 'Booked',
      campaign_id: 9, agent_id: 55, customer_id: 301, business_unit_id: 12, job_number: '99001', has_recording: true, has_voicemail: false, modified_on: '2026-03-01T10:05:00Z',
    });
    // PII minimisation: caller and dialled numbers stay out of list rows (get_call has them).
    for (const row of out.calls) {
      expect(row).not.toHaveProperty('from');
      expect(row).not.toHaveProperty('to');
    }
    expect(JSON.stringify(out)).not.toContain('8435550100');
    expect(out.calls[1].id).toBe(4002);
    expect(out.calls[1].job_number).toBe('99002');
    expect(out.calls[1].business_unit_id).toBe(13);
    expect(out.count).toBe(2);
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
  });

  it('returns count 0 on an empty page', async () => {
    const out = (await calls_list.handler(jsonEnv({ data: [] }), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.calls).toEqual([]);
  });
});

describe('call_recording_get / call_voicemail_get', () => {
  it('reports availability, content type and bytes without returning audio', async () => {
    const env = envWith(() => new Response(new Uint8Array([73, 68, 51, 4, 0]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const out = (await call_recording_get.handler(env, { callId: 4001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Ftelecom%2Fv2%2Ftenant%2F000000000%2Fcalls%2F4001%2Frecording');
    expect(out).toEqual({ call_id: 4001, kind: 'recording', available: true, status: 200, content_type: 'audio/mpeg', bytes_received: 5, _source: 'live' });
    expectCalledPathMatchesDeclared(call_recording_get, calledUrl(env), calledInit(env));
    expect(JSON.stringify(out)).not.toContain('ID3');
  });

  it('voicemail hits the /voicemail path', async () => {
    const env = envWith(() => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const out = (await call_voicemail_get.handler(env, { callId: 4001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fcalls%2F4001%2Fvoicemail');
    expect(out.kind).toBe('voicemail');
    expect(out.content_type).toBe('audio/wav');
    expect(out.bytes_received).toBe(2);
    expectCalledPathMatchesDeclared(call_voicemail_get, calledUrl(env), calledInit(env));
  });

  it('reports available:false on a 2xx with an empty body', async () => {
    const env = envWith(() => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const out = (await call_recording_get.handler(env, { callId: 4001 }, CTX)) as any;
    expect(out.available).toBe(false);
    expect(out.status).toBe(200);
    expect(out.bytes_received).toBe(0);
  });

  it('describes 404 as no media found, not proof that no recording exists', () => {
    expect(call_recording_get.description).toContain('404 = no media found');
    expect(call_voicemail_get.description).toContain('404 = no media found');
    expect(call_recording_get.description).not.toMatch(/means no recording/);
    expect(call_voicemail_get.description).not.toMatch(/means no voicemail/);
  });

  it('treats 404 as available:false, not an error', async () => {
    const env = envWith(() => new Response('not found', { status: 404 }));
    const out = (await call_recording_get.handler(env, { callId: 4001 }, CTX)) as any;
    expect(out).toEqual({ call_id: 4001, kind: 'recording', available: false, status: 404, content_type: null, bytes_received: null, _source: 'live' });
  });

  it('throws McpError on a non-404 upstream failure', async () => {
    const env = envWith(() => new Response('boom', { status: 503 }));
    await expect(call_voicemail_get.handler(env, { callId: 4001 }, CTX)).rejects.toThrow(/call media returned HTTP 503/);
  });
});

describe('call media hardening', () => {
  it('forwards no query params and resolves the tenant placeholder to the configured tenant', async () => {
    const env = envWith(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    env.ST_TENANT_ID = '123456789';
    await call_recording_get.handler(env, { callId: 4001 }, CTX);
    const url = calledUrl(env);
    expect(decodeURIComponent(url.split('endpoint=')[1])).toBe('/telecom/v2/tenant/123456789/calls/4001/recording');
    expect(url).not.toContain('000000000');
  });

  it('counts bytes by streaming and cancels past the cap instead of buffering the body', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) { controller.close(); return; }
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const env = envWith(() => new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const out = (await fetchCallMediaMeta(env, CTX, 4001, 'recording')) as any;
    expect(out.available).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.bytes_received).toBeGreaterThan(0);
    expect(out.bytes_received).toBeLessThan(1000 * 1024 * 1024);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(200);
  });

  it('does not echo a non-404 error body beyond the truncated message and keeps the correlation', async () => {
    const env = envWith(() => new Response('x'.repeat(5000), { status: 500 }));
    const err: any = await call_recording_get.handler(env, { callId: 4001 }, CTX).catch((e) => e);
    expect(String(err.message).length).toBeLessThan(420);
    expect(err.correlation).toBe('c1');
  });

  it('media tool descriptions say the audio is not returned', () => {
    for (const t of [call_recording_get, call_voicemail_get]) {
      expect(t.description).toMatch(/NOT returned/);
    }
  });

  it('a 429 carries retry_after_ms from Retry-After, like readST', async () => {
    const env = envWith(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    const err: any = await call_recording_get.handler(env, { callId: 4001 }, CTX).catch((e) => e);
    expect(err.name).toBe('McpError');
    expect(err.retry_after_ms).toBe(7000);
    expect(err.correlation).toBe('c1');
  });

  it('a 429 without Retry-After defaults to 60s', async () => {
    const env = envWith(() => new Response('slow down', { status: 429 }));
    const err: any = await call_voicemail_get.handler(env, { callId: 4001 }, CTX).catch((e) => e);
    expect(err.retry_after_ms).toBe(60000);
  });

  it('a stream that errors mid-body surfaces as McpError with the correlation id', async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        n += 1;
        if (n === 1) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new TypeError('network connection lost'));
      },
    });
    const env = envWith(() => new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const err: any = await call_recording_get.handler(env, { callId: 4001 }, CTX).catch((e) => e);
    expect(err.name).toBe('McpError');
    expect(err.code).toBe('upstream_error');
    expect(err.correlation).toBe('c1');
    expect(err.message).toMatch(/body read failed on \/telecom\/v2\/tenant\/000000000\/calls\/4001\/recording/);
  });
});

describe('calls_list row-match filter guards (ST ignores unknown params)', () => {
  it('passes when every row (flat and nested) matches campaignId and agentId', async () => {
    const env = jsonEnv({ data: [FLAT_CALL, NESTED_CALL] });
    const out = (await calls_list.handler(env, { campaignId: 9, agentId: 55 }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['campaignId', { campaignId: 9 }, { campaign: { id: 10 } }],
    ['agentId', { agentId: 55 }, { agent: { id: 56 } }],
  ])('throws when one nested row mismatches %s', async (param, args, override) => {
    const bad = { ...NESTED_CALL, leadCall: { ...NESTED_CALL.leadCall, id: 4009, ...override } };
    const env = jsonEnv({ data: [FLAT_CALL, bad] });
    await expect(calls_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`calls_list: ST ignored the ${param} filter`),
    });
  });
});
