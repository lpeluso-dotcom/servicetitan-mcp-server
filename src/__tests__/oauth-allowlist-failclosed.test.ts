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

describe('ALLOWED_EMAILS allow-list fails closed', () => {
  function envWithout(allowed?: string) {
    return {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
      SELF_ORIGIN: 'https://example.workers.dev',
      ...(allowed === undefined ? {} : { ALLOWED_EMAILS: allowed }),
      OAUTH_FLOW_STATE: oauthFlowStateStub({}),
      OAUTH_KV: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as never;
  }

  it('does not throw on /callback when ALLOWED_EMAILS is undefined', async () => {
    const req = new Request('https://example.workers.dev/callback?state=00000000-0000-4000-8000-0000000000aa&code=c');
    const res = await handleOAuthRoute(req, envWithout(), new URL(req.url));
    
    
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it('does not throw on /callback when ALLOWED_EMAILS is blank', async () => {
    const req = new Request('https://example.workers.dev/callback?state=00000000-0000-4000-8000-0000000000aa&code=c');
    const res = await handleOAuthRoute(req, envWithout(''), new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
