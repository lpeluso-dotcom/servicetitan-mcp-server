import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';
import { makeStatefulDB, CTX } from '../../tools/sales/__tests__/helpers';
import { clearStTokenCache } from '../st-oauth';

interface NoteArgs { jobId: number; text: string; dryRun?: boolean; confirmation_token?: string }

const probe = defineWriteTool<NoteArgs>({
  name: 'direct_probe_note',
  description: 'Probe write for the direct backend test. Source: live ST.',
  zodSchema: { jobId: z.number().int(), text: z.string() },
  endpoint: ({ jobId }) => `/jpm/v2/tenant/000000000/jobs/${jobId}/notes`,
  method: 'POST',
  payload: ({ text }) => ({ text }),
});

describe('defineWriteTool on the direct backend', () => {
  let apiCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    clearStTokenCache();
    apiCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/connect/token')) return new Response('{"access_token":"t","expires_in":900}');
      apiCalls.push({ url: String(url), init });
      return new Response('{"id":42}', { status: 200 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('dryRun makes no call; confirm posts the payload to api.servicetitan.io', async () => {
    const env: any = {
      ST_BACKEND: 'direct', ST_CLIENT_ID: 'c', ST_CLIENT_SECRET: 's', ST_APP_KEY: 'k', ST_TENANT_ID: '555',
      DB: makeStatefulDB(), LEGACY_TEST_KEY: 'test-key', CONFIRMATION_SIGNING_KEY: 'test-key', MCP_SERVICE_VERSION: 't',
    };
    const preview: any = await probe.handler(env, { jobId: 7, text: 'hi', dryRun: true }, CTX);
    expect(preview.dryRun).toBe(true);
    expect(apiCalls).toHaveLength(0);

    const done: any = await probe.handler(env, { jobId: 7, text: 'hi', dryRun: false, confirmation_token: preview.confirmation_token }, CTX);
    expect(done).toMatchObject({
      dryRun: false,
      tool: 'direct_probe_note',
      
      
      result: { success: true, endpoint: '/jpm/v2/tenant/555/jobs/7/notes', method: 'POST', response: { id: 42 } },
    });
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toBe('https://api.servicetitan.io/jpm/v2/tenant/555/jobs/7/notes');
    expect(apiCalls[0].init.method).toBe('POST');
    expect(apiCalls[0].init.body).toBe('{"text":"hi"}');
    expect((apiCalls[0].init.headers as Record<string, string>)['ST-App-Key']).toBe('k');
  });
});
