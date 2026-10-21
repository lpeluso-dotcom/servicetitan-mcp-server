import { describe, it, expect, vi } from 'vitest';


vi.mock('@cloudflare/workers-oauth-provider', () => {
  const base64UrlDecode = (str: string) => {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    base64 = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return atob(base64);
  };
  return {
    OAuthProvider: vi.fn(),
    parseJwtJsonPart: (part: string) => JSON.parse(base64UrlDecode(part)),
    base64UrlToBytes: (str: string) => {
      const decoded = base64UrlDecode(str);
      const arr = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) arr[i] = decoded.charCodeAt(i);
      return arr;
    },
  };
});

import { handleOAuthRoute } from '../oauth';
import { oauthFlowStateStub } from './oauth-flow-state-stub';

function kvStub(store: Record<string, unknown>) {
  return {
    get: async (k: string, _t?: string) => store[k] ?? null,
    put: async (k: string, v: string) => {
      store[k] = JSON.parse(v);
    },
    delete: async (k: string) => {
      delete store[k];
    },
  };
}

function call(url: string, env: unknown, init?: RequestInit) {
  const req = new Request(url, init);
  return handleOAuthRoute(req, env as never, new URL(req.url));
}

const PENDING = {
  oauthReqInfo: {
    clientId: 'attacker-client',
    redirectUri: 'https://evil.example/cb',
    scope: ['openid'],
  },
  sub: 'user-sub-1',
  email: 'ok@example.org',
  name: 'Ok User',
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('OAuth consent screen', () => {
  it('POST /approve with decision=approve is what completes authorization', async () => {
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: 'https://client.example/cb?code=x',
    }));
    const store: Record<string, unknown> = { 'approve:00000000-0000-4000-8000-000000000001': { ...PENDING } };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(store),
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-000000000001&decision=approve',
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(303);
    expect(res!.headers.get('location')).toBe('https://client.example/cb?code=x');
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    
    expect(store['approve:00000000-0000-4000-8000-000000000001']).toBeUndefined();
  });

  it('finds parked consent state even when KV returns null for the key (eventual consistency)', async () => {
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: 'https://client.example/cb?code=x',
    }));
    const flowStore: Record<string, unknown> = { 'approve:00000000-0000-4000-8000-000000000006': { ...PENDING } };
    const lateKv = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(flowStore),
      OAUTH_KV: lateKv,
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const page = await call('https://example.workers.dev/approve?state=00000000-0000-4000-8000-000000000006', env);
    expect(page!.status).toBe(200);
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-000000000006&decision=approve',
    });
    expect(res!.status).toBe(303);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    // single use: a replay of the same POST finds nothing
    const replay = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-000000000006&decision=approve',
    });
    expect(replay!.status).toBe(400);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it('POST /approve with decision=deny does NOT complete authorization', async () => {
    const completeAuthorization = vi.fn();
    const store: Record<string, unknown> = { 'approve:00000000-0000-4000-8000-000000000002': { ...PENDING } };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(store),
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-000000000002&decision=deny',
    });
    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(store['approve:00000000-0000-4000-8000-000000000002']).toBeUndefined();
  });

  it('POST /approve with an unknown state is rejected', async () => {
    const completeAuthorization = vi.fn();
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub({}),
      OAUTH_KV: kvStub({}),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-0000000000ff&decision=approve',
    });
    expect(res!.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('re-checks the allow-list at approval time', async () => {
    const completeAuthorization = vi.fn();
    const store: Record<string, unknown> = { 'approve:00000000-0000-4000-8000-000000000004': { ...PENDING } };
    const env = {
      
      ALLOWED_EMAILS: 'someone-else@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(store),
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=00000000-0000-4000-8000-000000000004&decision=approve',
    });
    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('the consent page names the client id, redirect uri and scopes', async () => {
    const store: Record<string, unknown> = {
      'approve:00000000-0000-4000-8000-000000000003': {
        oauthReqInfo: {
          clientId: 'some-client',
          redirectUri: 'https://client.example/cb',
          scope: ['openid', 'email'],
        },
        sub: 'user-sub-3',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(store),
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
    };
    const res = await call('https://example.workers.dev/approve?state=00000000-0000-4000-8000-000000000003', env);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('text/html');
    const html = await res!.text();
    expect(html).toContain('some-client');
    expect(html).toContain('https://client.example/cb');
    expect(html).toContain('openid, email');
    expect(res!.headers.get('content-security-policy')).toContain("form-action 'self' https://client.example");
    expect(res!.headers.get('content-security-policy')).not.toContain('evil.example');
    
    expect(store['approve:00000000-0000-4000-8000-000000000003']).toBeDefined();
  });

  it('escapes HTML in the client id so a hostile name cannot inject markup', async () => {
    const store: Record<string, unknown> = {
      'approve:00000000-0000-4000-8000-000000000005': {
        oauthReqInfo: {
          clientId: '<script>alert(1)</script>',
          redirectUri: 'https://client.example/cb',
          scope: ['openid'],
        },
        sub: 'user-sub-5',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: oauthFlowStateStub(store),
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
    };
    const res = await call('https://example.workers.dev/approve?state=00000000-0000-4000-8000-000000000005', env);
    const html = await res!.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects a state that is not a UUID with 400, before it reaches the Durable Object', async () => {
    const completeAuthorization = vi.fn();
    const flow = oauthFlowStateStub({});
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_FLOW_STATE: flow,
      OAUTH_KV: kvStub({}),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const post = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=junk&decision=approve',
    });
    expect(post!.status).toBe(400);
    expect(await post!.text()).toBe('invalid_or_expired_state');
    const get = await call(`https://example.workers.dev/approve?state=${'a'.repeat(5000)}`, env);
    expect(get!.status).toBe(400);
    const cb = await call('https://example.workers.dev/callback?state=not-a-uuid&code=c', env);
    expect(cb!.status).toBe(400);
    expect(await cb!.text()).toBe('invalid_or_expired_state');
    expect(flow.names).toEqual([]);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
