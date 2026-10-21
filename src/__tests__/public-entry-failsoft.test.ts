import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

vi.mock('agents/mcp', () => ({ createMcpHandler: () => async () => new Response('mcp-ok') }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response('oauth') }),
  handleOAuthRoute: async () => null,
}));
// Simulate an SDK upgrade that changed the internals the wrap reaches into.
vi.mock('../tool-list-compact', () => ({ compactToolListOnWire: () => false }));

const entry = await import('../public-entry');
const { PUBLIC_TOOLS } = await import('../tools/public-registry');
const { filterToolsForRole } = await import('../tools/role-filter');

function makeEnv(): any {
  const stmt = { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true }), first: vi.fn().mockResolvedValue(null) };
  return { DB: { prepare: vi.fn().mockReturnValue(stmt) }, MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000', ST_BACKEND: 'direct', MCP_TOKEN: 's3cret' };
}

describe('public entry tools/list fail-soft', () => {
  it('still serves the full tool list, and warns once, when the compaction wrap cannot be installed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let server!: ReturnType<typeof entry.buildPublicServer>;
      expect(() => {
        server = entry.buildPublicServer(makeEnv(), { waitUntil: () => undefined } as any, { actor: 't', role: 'default' });
      }).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('compactToolListOnWire');

      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'failsoft-test', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((t) => t.name).sort()).toEqual(
          filterToolsForRole(PUBLIC_TOOLS, 'default').map((t) => t.name).sort(),
        );
      } finally {
        await client.close();
      }
    } finally {
      warn.mockRestore();
    }
  });
});
