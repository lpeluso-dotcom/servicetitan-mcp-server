import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDirectBackend } from '../direct';
import { clearStTokenCache } from '../st-oauth';

const ENV = {
  ST_CLIENT_ID: 'cid',
  ST_CLIENT_SECRET: 'csecret',
  ST_APP_KEY: 'app-key',
  ST_TENANT_ID: '555',
};

const READ = (endpoint: string) =>
  `https://proxy-backend/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;

describe('createDirectBackend', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let apiCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    clearStTokenCache();
    apiCalls = [];
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/connect/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 900 }), { status: 200 });
      }
      apiCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: [{ id: 1 }], hasMore: false }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('serves a GET read against api.servicetitan.io with bearer + app key and no proxy headers', async () => {
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch(READ('/crm/v2/tenant/000000000/customers?page=1'), {
      headers: { 'X-Legacy-Header': 'must-not-leak', 'X-Actor': 'someone' },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ data: [{ id: 1 }], hasMore: false });
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toBe('https://api.servicetitan.io/crm/v2/tenant/555/customers?page=1');
    expect(apiCalls[0].init.method).toBe('GET');
    const headers = apiCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['ST-App-Key']).toBe('app-key');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-legacy-header');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-actor');
  });

  it('forwards a POST-as-read body', async () => {
    const backend = createDirectBackend(ENV);
    await backend.fetch(READ('/dispatch/v2/tenant/555/capacity'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startsOnOrAfter: '2026-09-25' }),
    });
    expect(apiCalls[0].init.method).toBe('POST');
    expect(apiCalls[0].init.body).toBe('{"startsOnOrAfter":"2026-09-25"}');
    expect((apiCalls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('turns a write envelope into the real method, path, and JSON body', async () => {
    const backend = createDirectBackend(ENV);
    await backend.fetch('https://proxy-backend/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-legacy-header': 'must-not-leak' },
      body: JSON.stringify({ endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes', method: 'POST', payload: { text: 'hi' } }),
    });
    expect(apiCalls[0].url).toBe('https://api.servicetitan.io/jpm/v2/tenant/555/jobs/7/notes');
    expect(apiCalls[0].init.method).toBe('POST');
    expect(apiCalls[0].init.body).toBe('{"text":"hi"}');
  });

  it('wraps a successful write in the same response envelope: {success, endpoint, method, response}', async () => {
    
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch('https://proxy-backend/api/st/write', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes', method: 'POST', payload: { text: 'hi' } }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      success: true,
      endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes',
      method: 'POST',
      response: { data: [{ id: 1 }], hasMore: false },
    });
  });

  it('wraps an empty 2xx ST body as response: { raw: "" }, matching that shape', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/connect/token')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 900 }), { status: 200 })
        : new Response('', { status: 200 }),
    );
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch('https://proxy-backend/api/st/write', {
      method: 'PATCH',
      body: JSON.stringify({ endpoint: '/sales/v2/tenant/000000000/estimate-templates/9/items', method: 'PATCH', payload: { qty: 2 } }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      success: true,
      endpoint: '/sales/v2/tenant/000000000/estimate-templates/9/items',
      method: 'PATCH',
      response: { raw: '' },
    });
  });

  it('wraps a ServiceTitan error as {error, endpoint, method, response} with the ST status code', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/connect/token')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 900 }), { status: 200 })
        : new Response(JSON.stringify({ message: 'Job not found' }), { status: 404 }),
    );
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch('https://proxy-backend/api/st/write', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes', method: 'POST', payload: { text: 'hi' } }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({
      error: 'ST API 404',
      endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes',
      method: 'POST',
      response: { message: 'Job not found' },
    });
  });

  it('clears the cached ST token on a 401 so the next call re-mints instead of replaying it', async () => {
    let tokenMints = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/connect/token')) {
        tokenMints += 1;
        return new Response(JSON.stringify({ access_token: `tok-${tokenMints}`, expires_in: 900 }), { status: 200 });
      }
      apiCalls.push({ url: String(url), init: {} as RequestInit });
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
    });
    const backend = createDirectBackend(ENV);
    const resp1 = await backend.fetch(READ('/crm/v2/tenant/555/customers'), { headers: {} });
    expect(resp1.status).toBe(401); 
    expect(tokenMints).toBe(1);
    await backend.fetch(READ('/crm/v2/tenant/555/customers'), { headers: {} });
    expect(tokenMints).toBe(2); 
  });

  it('sends DELETE without a body', async () => {
    const backend = createDirectBackend(ENV);
    await backend.fetch('https://proxy-backend/api/st/write', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '/sales/v2/tenant/555/estimate-templates/9', method: 'DELETE', payload: {} }),
    });
    expect(apiCalls[0].init.method).toBe('DELETE');
    expect(apiCalls[0].init.body).toBeUndefined();
  });

  it('uses the integration API host when ST_ENV=integration', async () => {
    const backend = createDirectBackend({ ...ENV, ST_ENV: 'integration' });
    await backend.fetch(READ('/crm/v2/tenant/555/customers'), { headers: {} });
    expect(apiCalls[0].url).toBe('https://api-integration.servicetitan.io/crm/v2/tenant/555/customers');
  });

  it('refuses an endpoint that would leave the ServiceTitan API origin', async () => {
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch(READ('//evil.example/steal'), { headers: {} });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: 'bad_endpoint' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown route without calling ServiceTitan', async () => {
    const backend = createDirectBackend(ENV);
    const resp = await backend.fetch('https://proxy-backend/api/st/legacy-route', { method: 'POST', body: '{}' });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toMatchObject({ error: 'unknown_route' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with a config error when ST_APP_KEY is missing', async () => {
    const backend = createDirectBackend({ ...ENV, ST_APP_KEY: undefined });
    await expect(backend.fetch(READ('/crm/v2/tenant/555/customers'), { headers: {} })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('ST_APP_KEY'),
    });
  });

  it('rejects with a config error naming ST_TENANT_ID when it is unset, before any ServiceTitan call', async () => {
    const backend = createDirectBackend({ ...ENV, ST_TENANT_ID: undefined });
    await expect(backend.fetch(READ('/crm/v2/tenant/000000000/customers'), { headers: {} })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('ST_TENANT_ID'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with a config error naming ST_TENANT_ID when it is still the placeholder', async () => {
    const backend = createDirectBackend({ ...ENV, ST_TENANT_ID: '000000000' });
    await expect(backend.fetch(READ('/crm/v2/tenant/000000000/customers'), { headers: {} })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('ST_TENANT_ID'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the call normally once ST_TENANT_ID is set to a real id', async () => {
    const backend = createDirectBackend({ ...ENV, ST_TENANT_ID: '555' });
    const resp = await backend.fetch(READ('/crm/v2/tenant/000000000/customers'), { headers: {} });
    expect(resp.status).toBe(200);
    expect(apiCalls[0].url).toBe('https://api.servicetitan.io/crm/v2/tenant/555/customers');
  });

  it('also rejects an unset ST_TENANT_ID on the write path, before any ServiceTitan call', async () => {
    const backend = createDirectBackend({ ...ENV, ST_TENANT_ID: undefined });
    await expect(
      backend.fetch('https://proxy-backend/api/st/write', {
        method: 'POST',
        body: JSON.stringify({ endpoint: '/jpm/v2/tenant/000000000/jobs/7/notes', method: 'POST', payload: { text: 'hi' } }),
      }),
    ).rejects.toMatchObject({ code: 'config_error', message: expect.stringContaining('ST_TENANT_ID') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
