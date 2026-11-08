// Bounded inline responses and authorized D1 result pages, including structuredContent.
import { releaseDB } from './release-db';
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import {
  offloadIfLarge,
  registerResultResource,
  RESULT_THRESHOLD,
  RESULT_TTL_S,
} from '../resources/results';
import { registerTool } from '../tool-registry';
import type { ToolDef } from '../tools/index';

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv() {
  // A stateful in-memory KV mock: put() actually persists so a later get()
  // in the same test can see it (needed for the round-trip / e2e tests),
  // while both remain vi.fn() spies for call-shape assertions. DB is a
  // no-op mock so registerTool's fire-and-forget obs.* calls stay clean.
  const store = new Map<string, string>();
  return {
    DB: releaseDB(),
    ST_TENANT_ID: "123",
    STATE_KV: {
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    },
  } as any;
}

const execCtx = { waitUntil: () => undefined } as any;

// Comfortably over RESULT_THRESHOLD (80_000 chars) when stringified.
function bigResult() {
  return {
    invoices: Array.from({ length: 3000 }, (_, i) => ({
      id: i,
      summary: 'x'.repeat(30),
    })),
    total: 3000,
  };
}

describe('offloadIfLarge — under threshold (byte-identical guarantee)', () => {
  it('returns offloaded:false with a text block equal to JSON.stringify(result) and unchanged structuredContent, and never touches KV', async () => {
    const env = makeEnv();
    const result = { customers: [{ id: 1, name: 'Fixture Customer' }], total: 1 };

    const shaped = await offloadIfLarge(env, 'corr-under-1', result, false);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(shaped.structuredContent).toEqual(result);
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });

  it('under-threshold output is identical whether or not the tool has an outputSchema (the flag only matters over threshold)', async () => {
    const env = makeEnv();
    const result = { customers: [{ id: 1 }], total: 1 };

    const noSchema = await offloadIfLarge(env, 'corr-under-1a', result, false);
    const withSchema = await offloadIfLarge(env, 'corr-under-1b', result, true);

    expect(withSchema).toEqual(noSchema);
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });

  it('wraps a bare array result as { result } for structuredContent, same as the pre-existing rule', async () => {
    const env = makeEnv();
    const result = [1, 2, 3];

    const shaped = await offloadIfLarge(env, 'corr-under-2', result, false);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(shaped.structuredContent).toEqual({ result });
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });

  it('wraps a null result as { result: null }, matching the `?? null` / { result } branches', async () => {
    const env = makeEnv();

    const shaped = await offloadIfLarge(env, 'corr-under-3', null, false);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: 'null' }]);
    expect(shaped.structuredContent).toEqual({ result: null });
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });
});


const owner = { actor: 'test', principal: 'jwt:alice', role: 'default' } as const;
async function clientFor(env: any, ctx: any = owner, tool?: ToolDef) {
  const server = new McpServer({ name: 'release-results', version: 'test' });
  registerResultResource(server, env, ctx);
  if (tool) registerTool(server, tool, env, execCtx, ctx);
  const [a,b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'release-client', version: 'test' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function reconstruct(client: Client, id: string, pages: number) {
  let text = '';
  let rowPath: string | undefined;
  let root: Record<string, unknown> | undefined;
  const items: unknown[] = [];
  for (let page=0;page<pages;page++) {
    const response = await client.readResource({ uri: `mcp-st://results/${id}/${page}` });
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThan(80_000);
    const body = JSON.parse((response.contents[0] as {text:string}).text);
    expect(body.next_cursor).toBe(page + 1 < pages ? page + 1 : null);
    if (body.encoding === 'row-page') {
      rowPath = body.items_path;
      root = body.root_fields ?? root;
      items.push(...body.items);
    } else {
      text += body.segment;
    }
  }
  if (!rowPath) return JSON.parse(text);
  if (rowPath === '$') return items;
  return { ...(root ?? {}), [rowPath]: items };
}
describe('bounded, immediately readable, authorized results', () => {
  it('pages large category trees exactly while retaining the ordinary tool ceiling', async () => {
    const env=makeEnv();const result={categories:[{subcategories:'x'.repeat(1_100_000)}]};
    await expect(offloadIfLarge(env,'ordinary',result,false,owner,'fixture')).rejects.toMatchObject({code:'validation_error'});
    const shaped=await offloadIfLarge(env,'category-tree',result,false,owner,'list_service_categories');
    expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeLessThan(RESULT_THRESHOLD);
    const client=await clientFor(env);
    expect(await reconstruct(client,'category-tree',Number(shaped.structuredContent._pages))).toEqual(result);
    await expect(offloadIfLarge(env,'oversized-tree',{text:'x'.repeat(8_388_609)},false,owner,'list_service_categories')).rejects.toMatchObject({code:'validation_error'});
  });
  it.each([false,true])('offloads both text and structuredContent (schema=%s), reconstructing exact JSON', async schema => {
    const env=makeEnv();const result=bigResult();
    const shaped=await offloadIfLarge(env,'large',result,schema,owner,'fixture');
    expect(shaped.offloaded).toBe(true);
    expect(shaped.structuredContent._offloaded).toBe(true);
    expect(shaped.structuredContent.invoices).toBeUndefined();
    expect(shaped.structuredContent._total_items).toBe(3000);
    expect(shaped.structuredContent._preview).toHaveLength(5);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeLessThan(RESULT_THRESHOLD);
    const client=await clientFor(env);
    expect(await reconstruct(client,'large',Number(shaped.structuredContent._pages))).toEqual(result);
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });
  it('retains freshness, partial warnings, counts, units and calculation basis in the initial envelope', async () => {
    const env = makeEnv();
    const result = {
      rows: Array.from({ length: 6000 }, (_, id) => ({ id, value: 'x'.repeat(30) })),
      total: 7000,
      returned_count: 6000,
      _source: 'gold',
      _as_of: '2026-09-07T20:00:00Z',
      _partial: true,
      _warnings: ['fixture is intentionally partial'],
      unit: 'USD',
      calculation_basis: 'fixture rows only',
    };
    const shaped = await offloadIfLarge(env, 'qualified', result, false, owner, 'fixture');
    expect(shaped.structuredContent).toMatchObject({
      _offloaded: true,
      _source: 'gold',
      _as_of: '2026-09-07T20:00:00Z',
      _partial: true,
      _warnings: ['fixture is intentionally partial'],
      total: 7000,
      returned_count: 6000,
      unit: 'USD',
      calculation_basis: 'fixture rows only',
    });
    expect(await reconstruct(await clientFor(env), 'qualified', Number(shaped.structuredContent._pages))).toEqual(result);
  });
  it.each([false,true])('never falls back to an oversized response on database failure (schema=%s)', async schema => {
    const env=makeEnv();env.DB.batch=vi.fn().mockRejectedValue(new Error('db unavailable'));
    await expect(offloadIfLarge(env,'failed',bigResult(),schema,owner)).rejects.toThrow('db unavailable');
  });
  it('denies missing identity even when a result identifier is known', async () => {
    const env=makeEnv();await expect(offloadIfLarge(env,'large',bigResult(),false)).rejects.toMatchObject({code:'auth_failed'});
  });
  it.each([
    { ...owner, principal:'jwt:bob' }, { ...owner, role:'readonly' }, { ...owner, role:'admin' },
  ])('denies cross-user and changed-role retrieval: %j', async ctx => {
    const env=makeEnv();await offloadIfLarge(env,'private',bigResult(),false,owner);
    const client=await clientFor(env,ctx);
    await expect(client.readResource({uri:'mcp-st://results/private/0'})).rejects.toThrow(/not authorized/);
  });
  it('denies expired and missing records', async () => {
    const env=makeEnv();await offloadIfLarge(env,'expired',bigResult(),false,owner);
    env.DB.db.exec('UPDATE mcp_result_pages SET expires_at=0');
    const client=await clientFor(env);
    await expect(client.readResource({uri:'mcp-st://results/expired'})).rejects.toThrow(/expired/);
    await expect(client.readResource({uri:'mcp-st://results/missing'})).rejects.toThrow(/not found/);
  });
  it('counts actual UTF-8 bytes including both MCP fields', async () => {
    const env=makeEnv();const result={text:'😀'.repeat(12000)};
    const shaped=await offloadIfLarge(env,'unicode',result,true,owner);
    expect(shaped.offloaded).toBe(true);
    expect(await reconstruct(await clientFor(env),'unicode',Number(shaped.structuredContent._pages))).toEqual(result);
  });
  it('passes a real SDK schema tool call and full paged retrieval without MCP Tasks', async () => {
    const env=makeEnv();const result=bigResult();
    const client=await clientFor(env,owner,{name:'fixture',permission:'staff',isWrite:false,description:'Synthetic large read',zodSchema:{},
      outputSchema:{invoices:z.array(z.record(z.string(),z.unknown())),total:z.number()},handler:async()=>result});
    const called=await client.callTool({name:'fixture',arguments:{}});
    expect(called.isError).toBeFalsy();
    expect(new TextEncoder().encode(JSON.stringify(called)).length).toBeLessThan(RESULT_THRESHOLD);
    const summary=called.structuredContent as {_full:string;_pages:number};
    const id=summary._full.split('/')[3];
    expect(await reconstruct(client,id,summary._pages)).toEqual(result);
  });
  it('denies a result page whose source tool the caller\'s served set (profile) hides, on both read paths', async () => {
    const env = makeEnv();
    await offloadIfLarge(env, 'profiled-hidden', bigResult(), false, owner, 'fixture');
    const hidden = { ...owner, availableTools: ['get_result_page', 'other_tool'] };
    const client = await clientFor(env, hidden, {
      name: 'get_result_page', permission: 'staff', isWrite: false, description: 'fixture',
      zodSchema: { result_id: z.string(), cursor: z.number().optional() }, handler: async () => null,
    });
    await expect(client.readResource({ uri: 'mcp-st://results/profiled-hidden/0' })).rejects.toThrow(/not authorized/);
    const called = await client.callTool({ name: 'get_result_page', arguments: { result_id: 'profiled-hidden', cursor: 0 } });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called.content)).toMatch(/not authorized/);
  });
  it('serves a result page whose source tool is in the caller\'s served set', async () => {
    const env = makeEnv();
    const shaped = await offloadIfLarge(env, 'profiled-visible', bigResult(), false, owner, 'fixture');
    const client = await clientFor(env, { ...owner, availableTools: ['get_result_page', 'fixture'] });
    expect(await reconstruct(client, 'profiled-visible', Number(shaped.structuredContent._pages))).toEqual(bigResult());
  });
  it('retrieves row pages through get_result_page with an unambiguous terminal cursor', async () => {
    const env = makeEnv();
    const shaped = await offloadIfLarge(env, 'tool-page', bigResult(), false, owner, 'fixture');
    const client = await clientFor(env, owner, {
      name: 'get_result_page', permission: 'staff', isWrite: false, description: 'fixture',
      zodSchema: { result_id: z.string(), cursor: z.number().optional() }, handler: async () => null,
    });
    const last = Number(shaped.structuredContent._pages) - 1;
    const called = await client.callTool({ name: 'get_result_page', arguments: { result_id: 'tool-page', cursor: last } });
    expect(called.isError).toBeFalsy();
    expect(called.structuredContent).toMatchObject({ status: 'ok', encoding: 'row-page', next_cursor: null });
  });
  // 2026-11-04: customer_snapshot offloaded 383 KB in 8 pages, and every
  // get_result_page call came back as a fresh _offloaded envelope instead of the page.
  it.each([
    ['json-text-segment', () => ({
      customer: { id: 106, name: 'Fixture "Customer"', notes: 'n'.repeat(4000) },
      jobs: Array.from({ length: 900 }, (_, id) => ({ id, summary: '"quoted" job text '.repeat(8) })),
      invoices: Array.from({ length: 700 }, (_, id) => ({ id, memo: 'invoice line, "with quotes"'.repeat(5) })),
      estimates: Array.from({ length: 500 }, (_, id) => ({ id, name: 'estimate '.repeat(12) })),
    })],
    ['row-page', () => ({
      rows: Array.from({ length: 4000 }, (_, id) => ({ id, value: '"q" '.repeat(10) })),
      context: 'c'.repeat(20_000),
    })],
  ])('get_result_page returns every %s page inline, never a re-offloaded envelope', async (encoding, build) => {
    const env = makeEnv();
    const result = build();
    const shaped = await offloadIfLarge(env, `snapshot-${encoding}`, result, false, owner, 'fixture');
    expect(shaped.offloaded).toBe(true);
    const client = await clientFor(env, owner, {
      name: 'get_result_page', permission: 'staff', isWrite: false, description: 'fixture',
      zodSchema: { result_id: z.string(), cursor: z.number().optional() }, handler: async () => null,
    });
    const pages = Number(shaped.structuredContent._pages);
    let text = '';
    let root: Record<string, unknown> = {};
    const items: unknown[] = [];
    let path = '';
    for (let cursor: number | null = 0, seen = 0; cursor !== null; seen++) {
      const called = await client.callTool({ name: 'get_result_page', arguments: { result_id: `snapshot-${encoding}`, cursor } });
      expect(called.isError).toBeFalsy();
      expect(new TextEncoder().encode(JSON.stringify(called)).length).toBeLessThan(RESULT_THRESHOLD);
      const page = called.structuredContent as Record<string, any>;
      expect(page._offloaded).toBeUndefined();
      expect(page).toMatchObject({ status: 'ok', encoding, page: cursor, page_count: pages });
      expect(JSON.parse((called.content as { text: string }[])[0].text)).toEqual(page);
      if (page.encoding === 'row-page') { path = page.items_path; root = page.root_fields ?? root; items.push(...page.items); }
      else text += page.segment;
      cursor = page.next_cursor;
      expect(seen).toBeLessThan(pages);
    }
    expect(path ? { ...root, [path]: items } : JSON.parse(text)).toEqual(result);
  });
  it('continues rejecting an invalid original output contract before offloading', async () => {
    const client=await clientFor(makeEnv(),owner,{name:'invalid',permission:'staff',isWrite:false,description:'Invalid fixture',zodSchema:{},outputSchema:{required:z.number()},handler:async()=>bigResult()});
    const called=await client.callTool({name:'invalid',arguments:{}});expect(called.isError).toBe(true);
  });
});
