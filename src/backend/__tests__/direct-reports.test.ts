import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReportQueryAsync } from '../../tools/reporting/st_run_report';
import { clearStTokenCache } from '../st-oauth';

const CTX = { actor: 'vitest', correlation: 'corr' };
const ENV: any = { ST_BACKEND: 'direct', ST_CLIENT_ID: 'c', ST_CLIENT_SECRET: 's', ST_APP_KEY: 'k', ST_TENANT_ID: '555', MCP_SERVICE_VERSION: 't' };

describe('report runs on the direct backend', () => {
  let apiCalls: Array<{ url: string; method: string; body?: unknown }>;

  beforeEach(() => {
    clearStTokenCache();
    apiCalls = [];
  });

  afterEach(() => vi.unstubAllGlobals());

  it('posts the query and polls the returned token', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/connect/token')) return new Response('{"access_token":"t","expires_in":900}');
      apiCalls.push({ url: String(url), method: String(init.method), body: init.body });
      if (String(url).includes('/data/query')) return new Response('{"token":"q1"}', { status: 202 });
      polls += 1;
      return polls < 2 ? new Response('{}', { status: 202 }) : new Response('{"data":[[1]]}', { status: 200 });
    }));

    const result = await runReportQueryAsync(ENV, CTX, 12, 34, { page: 1, pageSize: 10, parameters: [] }, 5, {
      identity: 'direct-report-test',
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ data: [[1]] });
    expect(apiCalls[0]).toEqual({
      url: 'https://api.servicetitan.io/reporting/v2/tenant/555/report-category/12/reports/34/data/query?page=1&pageSize=10',
      method: 'POST',
      body: '{"parameters":[]}',
    });
    expect(apiCalls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.servicetitan.io/reporting/v2/tenant/555/data-queries/q1',
      'GET https://api.servicetitan.io/reporting/v2/tenant/555/data-queries/q1',
    ]);
  });
});
