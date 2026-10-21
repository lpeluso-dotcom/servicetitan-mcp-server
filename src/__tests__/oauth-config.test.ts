import { describe, it, expect } from 'vitest';
import { isOAuthConfigured } from '../oauth-config';
import type { OAuthFlowState } from '../durable/oauth-flow-state';

const COMPLETE = {
  OAUTH_KV: {} as unknown as KVNamespace,
  OAUTH_FLOW_STATE: {} as unknown as DurableObjectNamespace<OAuthFlowState>,
  ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
  ACCESS_CLIENT_ID: 'client-id',
  ACCESS_CLIENT_SECRET: 'client-secret',
  ALLOWED_EMAILS: 'a@example.com',
};

describe('isOAuthConfigured', () => {
  it('is true when OAUTH_KV is bound and all four Access settings are present and non-blank', () => {
    expect(isOAuthConfigured(COMPLETE)).toBe(true);
  });

  it('is false when OAUTH_KV is not bound, even with a complete Access config', () => {
    expect(isOAuthConfigured({ ...COMPLETE, OAUTH_KV: undefined as unknown as KVNamespace })).toBe(false);
  });

  it('is false when OAUTH_FLOW_STATE is not bound, so an upgrade without the Durable Object binding degrades instead of throwing', () => {
    expect(isOAuthConfigured({ ...COMPLETE, OAUTH_FLOW_STATE: undefined as unknown as DurableObjectNamespace<OAuthFlowState> })).toBe(false);
  });

  it.each(['ACCESS_ISSUER', 'ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'ALLOWED_EMAILS'] as const)(
    'is false when %s is missing',
    (key) => {
      const env = { ...COMPLETE };
      delete (env as Record<string, unknown>)[key];
      expect(isOAuthConfigured(env)).toBe(false);
    },
  );

  it.each(['ACCESS_ISSUER', 'ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'ALLOWED_EMAILS'] as const)(
    'is false when %s is blank or whitespace-only',
    (key) => {
      expect(isOAuthConfigured({ ...COMPLETE, [key]: '' })).toBe(false);
      expect(isOAuthConfigured({ ...COMPLETE, [key]: '   ' })).toBe(false);
    },
  );
});
