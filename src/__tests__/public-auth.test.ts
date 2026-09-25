import { describe, it, expect } from 'vitest';
import { resolvePublicAuth } from '../public-auth';

const req = (auth?: string) => new Request('https://w.example/mcp', { method: 'POST', headers: auth ? { authorization: auth } : {} });

describe('resolvePublicAuth', () => {
  it('accepts the configured token as the default role', async () => {
    expect(await resolvePublicAuth(req('Bearer s3cret'), { MCP_TOKEN: 's3cret' } as any)).toEqual({
      authenticated: true, role: 'default', actor: 'mcp-token', principal: 'mcp-token', authMode: 'mcp-token',
    });
  });

  it('denies a wrong, missing, or non-bearer credential', async () => {
    for (const h of ['Bearer nope', undefined, 's3cret', 'Basic s3cret']) {
      expect((await resolvePublicAuth(req(h), { MCP_TOKEN: 's3cret' } as any)).authenticated).toBe(false);
    }
  });

  it('denies everyone when MCP_TOKEN is not configured', async () => {
    for (const token of [undefined, '', 'undefined']) {
      expect((await resolvePublicAuth(req('Bearer undefined'), { MCP_TOKEN: token } as any)).authenticated).toBe(false);
    }
  });

  it('honors MCP_TOKEN_ROLE=readonly and MCP_LOCKDOWN=true', async () => {
    expect((await resolvePublicAuth(req('Bearer s3cret'), { MCP_TOKEN: 's3cret', MCP_TOKEN_ROLE: 'readonly' } as any)).role).toBe('readonly');
    expect((await resolvePublicAuth(req('Bearer s3cret'), { MCP_TOKEN: 's3cret', MCP_LOCKDOWN: 'true' } as any)).role).toBe('lockdown');
  });

  it('never accepts the token from a query string, even with no auth header', async () => {
    const withQuery = new Request('https://w.example/mcp?token=s3cret&authorization=Bearer%20s3cret', { method: 'POST' });
    expect((await resolvePublicAuth(withQuery, { MCP_TOKEN: 's3cret' } as any)).authenticated).toBe(false);
  });

  it('never grants admin via MCP_TOKEN_ROLE, and fails an unrecognized role closed to readonly (safest allowed role), not default', async () => {
    for (const bad of ['admin', 'ADMIN', 'Admin', 'write', 'READONLY', 'reedonly', '']) {
      const result = await resolvePublicAuth(req('Bearer s3cret'), { MCP_TOKEN: 's3cret', MCP_TOKEN_ROLE: bad } as any);
      expect(result.role).not.toBe('admin');
      expect(result.role).toBe('readonly');
    }
  });

  it('MCP_LOCKDOWN=true wins over any MCP_TOKEN_ROLE, including an attempted admin value', async () => {
    expect(
      (await resolvePublicAuth(req('Bearer s3cret'), { MCP_TOKEN: 's3cret', MCP_TOKEN_ROLE: 'admin', MCP_LOCKDOWN: 'true' } as any)).role,
    ).toBe('lockdown');
  });

  it('accepts the bearer scheme case-insensitively (RFC 7235)', async () => {
    const lower = await resolvePublicAuth(req('bearer s3cret'), { MCP_TOKEN: 's3cret' } as any);
    expect(lower.authenticated).toBe(true);
    expect(lower.role).toBe('default');

    const upper = await resolvePublicAuth(req('BEARER s3cret'), { MCP_TOKEN: 's3cret' } as any);
    expect(upper.authenticated).toBe(true);
    expect(upper.role).toBe('default');

    const mixed = await resolvePublicAuth(req('BeArEr s3cret'), { MCP_TOKEN: 's3cret' } as any);
    expect(mixed.authenticated).toBe(true);
  });

  it('rejects an empty or whitespace-only token, a bare scheme with no token, and any non-bearer scheme, case-insensitively', async () => {
    for (const h of ['Bearer ', 'bearer', 'Bearer   ', 'Basic s3cret', 'basic s3cret']) {
      expect((await resolvePublicAuth(req(h), { MCP_TOKEN: 's3cret' } as any)).authenticated).toBe(false);
    }
  });

  it('rejects a token containing internal whitespace', async () => {
    expect((await resolvePublicAuth(req('Bearer s3 cret'), { MCP_TOKEN: 's3cret' } as any)).authenticated).toBe(false);
    expect((await resolvePublicAuth(req('bearer  s3cret  extra'), { MCP_TOKEN: 's3cret' } as any)).authenticated).toBe(false);
  });
});
