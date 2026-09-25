import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  backendName,
  stTransport,
  proxyReadUrl,
  backendRead,
  backendWrite,
  backendBindingChecks,
} from '../index';
import { clearStTokenCache } from '../st-oauth';

afterEach(() => {
  vi.unstubAllGlobals();
  clearStTokenCache();
});

describe('backendName', () => {
  it('defaults to direct and accepts direct', () => {
    expect(backendName({})).toBe('direct');
    expect(backendName({ ST_BACKEND: '' })).toBe('direct');
    expect(backendName({ ST_BACKEND: 'direct' })).toBe('direct');
  });

  it('throws a config_error on any other value', () => {
    expect(() => backendName({ ST_BACKEND: 'bogus' })).toThrow("ST_BACKEND must be 'direct' (or unset)");
    try {
      backendName({ ST_BACKEND: 'bogus' });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('config_error');
    }
  });
});

describe('stTransport', () => {
  it('prefers the per-request ST_TRANSPORT over everything', () => {
    const scoped = { fetch: vi.fn() };
    expect(stTransport({ ST_TRANSPORT: scoped as any })).toBe(scoped);
  });

  it('routes to api.servicetitan.io in direct mode and reuses one backend per env', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/connect/token')) return new Response('{"access_token":"t","expires_in":900}');
      return new Response('{"data":[]}');
    }));
    const env: any = { ST_BACKEND: 'direct', ST_CLIENT_ID: 'c', ST_CLIENT_SECRET: 's', ST_APP_KEY: 'k', ST_TENANT_ID: '9' };
    expect(stTransport(env)).toBe(stTransport(env));
    const resp = await backendRead(env, '/crm/v2/tenant/000000000/customers', { headers: {} });
    expect(resp.status).toBe(200);
    expect(calls).toEqual(['https://auth.servicetitan.io/connect/token', 'https://api.servicetitan.io/crm/v2/tenant/9/customers']);
  });
});

describe('backendBindingChecks', () => {
  it('checks the app secrets in direct mode and reports a bad ST_BACKEND', () => {
    expect(backendBindingChecks({ ST_BACKEND: 'direct', ST_CLIENT_ID: 'c', ST_APP_KEY: 'k' })).toEqual({
      'secret:ST_CLIENT_ID': true,
      'secret:ST_CLIENT_SECRET': false,
      'secret:ST_APP_KEY': true,
    });
    expect(backendBindingChecks({ ST_BACKEND: 'bogus' })).toEqual({ 'config:ST_BACKEND': false });
  });
});

describe('backendRead/backendWrite request shape', () => {
  it('backendRead builds the read URL against the transport', async () => {
    const transport = { fetch: vi.fn(async () => new Response('{}', { status: 200 })) };
    const env: any = { ST_TRANSPORT: transport };
    const init = { headers: { Authorization: 'x' } };
    await backendRead(env, '/crm/v2/tenant/1/customers?page=2', init);
    expect(transport.fetch).toHaveBeenCalledWith(
      'https://st-backend.invalid/api/st/read?endpoint=%2Fcrm%2Fv2%2Ftenant%2F1%2Fcustomers%3Fpage%3D2',
      init,
    );
    expect(proxyReadUrl('/a?b=c')).toBe('https://st-backend.invalid/api/st/read?endpoint=%2Fa%3Fb%3Dc');
  });

  it('backendWrite wraps the body in the write envelope', async () => {
    const transport = { fetch: vi.fn(async () => new Response('{}', { status: 200 })) };
    const env: any = { ST_TRANSPORT: transport };
    const signal = new AbortController().signal;
    await backendWrite(env, { endpoint: '/x', method: 'PATCH', payload: { a: 1 } }, { headers: { h: '1' }, signal });
    expect(transport.fetch).toHaveBeenCalledWith('https://st-backend.invalid/api/st/write', {
      method: 'POST',
      headers: { h: '1' },
      body: '{"endpoint":"/x","method":"PATCH","payload":{"a":1}}',
      signal,
    });
  });
});
