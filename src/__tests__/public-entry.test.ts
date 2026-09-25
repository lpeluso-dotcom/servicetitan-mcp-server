import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestContext } from '../tool-registry';


vi.mock('agents/mcp', () => ({ createMcpHandler: () => async () => new Response('mcp-ok') }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response('oauth') }),
  handleOAuthRoute: async () => null,
}));

const entry = await import('../public-entry');
const { PUBLIC_TOOLS } = await import('../tools/public-registry');
const { filterToolsForRole } = await import('../tools/role-filter');

function makeEnv(extra: Record<string, unknown> = {}): any {
  const stmt = { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }), first: vi.fn().mockResolvedValue(null) };
  return {
    ST_RATE_LIMITER: { idFromName: () => 'x', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
    DB: { prepare: vi.fn().mockReturnValue(stmt) },
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    ST_BACKEND: 'direct',
    MCP_TOKEN: 's3cret',
    ...extra,
  };
}
const execCtx = { waitUntil: () => undefined } as any;

async function listNames(reqCtx: RequestContext): Promise<{ names: string[]; instructions?: string }> {
  const server = entry.buildPublicServer(makeEnv(), execCtx, reqCtx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'public-entry-test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const listed = await client.listTools();
    return { names: listed.tools.map((t) => t.name).sort(), instructions: client.getInstructions() };
  } finally {
    await client.close();
  }
}

describe('public entry', () => {
  it.each(['default', 'readonly'] as const)('serves exactly the %s-filtered public tools', async (role) => {
    const { names, instructions } = await listNames({ actor: 't', role });
    expect(names).toEqual(filterToolsForRole(PUBLIC_TOOLS, role).map((t) => t.name).sort());
    expect(instructions).toBe(entry.PUBLIC_INSTRUCTIONS);
    if (role === 'readonly') {
      const writes = PUBLIC_TOOLS.filter((t) => t.isWrite).map((t) => t.name);
      for (const w of writes) expect(names).not.toContain(w);
    }
  });

  it('answers /health without auth', async () => {
    const resp = await entry.default.fetch(new Request('https://w.example/health'), makeEnv(), execCtx);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true, service: 'servicetitan-mcp-server', toolCount: PUBLIC_TOOLS.length, backend: 'direct' });
  });

  it('/health reports "direct" when ST_BACKEND is left unset (the public build has no proxy binding to fall back to)', async () => {
    const env = makeEnv({ ST_BACKEND: undefined });
    delete (env as { ST_BACKEND?: string }).ST_BACKEND;
    const resp = await entry.default.fetch(new Request('https://w.example/health'), env, execCtx);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ backend: 'direct' });
  });

  it('rejects /mcp without the token and admits it with the token', async () => {
    const post = (auth?: string) =>
      entry.default.fetch(new Request('https://w.example/mcp', { method: 'POST', headers: auth ? { authorization: auth } : {} }), makeEnv(), execCtx);
    expect((await post()).status).toBe(401);
    expect((await post('Bearer wrong')).status).toBe(401);
    const ok = await post('Bearer s3cret');
    expect(await ok.text()).toBe('mcp-ok');
  });

  const COMPLETE_OAUTH_CONFIG = {
    OAUTH_KV: {},
    ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
    ACCESS_CLIENT_ID: 'client-id',
    ACCESS_CLIENT_SECRET: 'client-secret',
    ALLOWED_EMAILS: 'a@example.com',
  };

  it('routes through the OAuth provider only when OAUTH_KV is bound and fully configured', async () => {
    const resp = await entry.default.fetch(new Request('https://w.example/health'), makeEnv(COMPLETE_OAUTH_CONFIG), execCtx);
    expect(await resp.text()).toBe('oauth');
  });

  it.each(['ACCESS_ISSUER', 'ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'ALLOWED_EMAILS'] as const)(
    'answers 503 oauth_not_configured on the OAuth routes when OAUTH_KV is bound but %s is missing, while /mcp and /health keep working',
    async (missingKey) => {
      const env = { ...COMPLETE_OAUTH_CONFIG };
      delete (env as Record<string, unknown>)[missingKey];
      const wrappedEnv = makeEnv(env);

      for (const path of ['/mcp-oauth', '/authorize', '/callback', '/approve']) {
        const resp = await entry.default.fetch(new Request(`https://w.example${path}`), wrappedEnv, execCtx);
        expect(resp.status).toBe(503);
        expect(await resp.json()).toEqual({ error: 'oauth_not_configured' });
      }

      const health = await entry.default.fetch(new Request('https://w.example/health'), wrappedEnv, execCtx);
      expect(health.status).toBe(200);

      const mcp = await entry.default.fetch(
        new Request('https://w.example/mcp', { method: 'POST', headers: { authorization: 'Bearer s3cret' } }),
        wrappedEnv,
        execCtx,
      );
      expect(await mcp.text()).toBe('mcp-ok');
    },
  );

  it('does not route incomplete-config OAuth routes through the OAuth provider', async () => {
    const env = { ...COMPLETE_OAUTH_CONFIG, ALLOWED_EMAILS: '' };
    const resp = await entry.default.fetch(new Request('https://w.example/health'), makeEnv(env), execCtx);
    
    
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true });
  });

  it('scheduled handler runs the retention cleanup in the background via waitUntil', async () => {
    const waited: unknown[] = [];
    const bgCtx = { waitUntil: (p: unknown) => waited.push(p) } as unknown as ExecutionContext;
    const env = makeEnv();
    await entry.default.scheduled?.({} as ScheduledController, env, bgCtx);
    expect(waited).toHaveLength(1);
    await waited[0]; 
    expect(env.DB.prepare).toHaveBeenCalled();
  });
});
