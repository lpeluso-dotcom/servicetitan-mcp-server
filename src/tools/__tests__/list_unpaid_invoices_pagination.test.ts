import { describe, it, expect, vi } from 'vitest';
import { list_unpaid_invoices } from '../invoicing/list_unpaid_invoices';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null), 
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string) => Promise<Response>): any {
  return {
    ST_TRANSPORT: { fetch: vi.fn((url: string) => fetchImpl(url)) },
    LEGACY_TEST_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    STATE_KV: {},
  };
}


function pageFromUrl(url: string): number {
  const endpoint = new URL(url).searchParams.get('endpoint') ?? '';
  const qs = endpoint.split('?')[1] ?? '';
  return Number(new URLSearchParams(qs).get('page') ?? '1');
}

function inv(id: number, balance: number) {
  return { id, balance, total: 500 };
}


function serve(pages: Record<number, unknown[]>) {
  const last = Math.max(...Object.keys(pages).map(Number));
  return async (url: string) => {
    const page = pageFromUrl(url);
    const data = pages[page] ?? [];
    return new Response(JSON.stringify({ data, hasMore: page < last }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('list_unpaid_invoices pagination', () => {
  it('does NOT return a bare [] when page 1 is all-paid and page 2 has unpaid rows', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 0), inv(2, 0), inv(3, 0)],       
      2: [inv(4, 250.5), inv(5, 100)],            
    }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.length).toBeGreaterThan(0);
    expect(out.invoices.map((i: any) => i.id).sort()).toEqual([4, 5]);
  });

  it('keeps draining across several all-paid pages', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 0)], 2: [inv(2, 0)], 3: [inv(3, 0)], 4: [inv(4, 0)],
      5: [inv(5, 42)],
    }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([5]);
  });

  it('reports an honest empty result when the source really is all paid', async () => {
    const env = makeEnv(serve({ 1: [inv(1, 0), inv(2, 0)] }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices).toEqual([]);
    
    expect(out._scan_complete).toBe(true);
  });

  it('distinguishes "nothing unpaid" from "gave up looking"', async () => {
    
    
    const pages: Record<number, unknown[]> = {};
    for (let p = 1; p <= 60; p++) pages[p] = [inv(p, 0)];
    const env = makeEnv(serve(pages));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices).toEqual([]);
    expect(out._scan_complete).toBe(false);
    expect(String(out._warning ?? '')).toMatch(/page budget|incomplete|not exhaustive/i);
  });

  it('stops early once the requested window is filled', async () => {
    const pages: Record<number, unknown[]> = {};
    for (let p = 1; p <= 40; p++) pages[p] = [inv(p, 99)]; 
    const env = makeEnv(serve(pages));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 3 }, CTX);

    expect(out.invoices).toHaveLength(3);
    
    expect(env.ST_TRANSPORT.fetch.mock.calls.length).toBeLessThan(10);
  });

  it('keeps a malformed balance visible rather than silently hiding the row', async () => {
    const env = makeEnv(serve({ 1: [{ id: 7, balance: 'not-a-number' }, inv(8, 0)] }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([7]);
  });

  it('honours the page argument against the FILTERED set, not ST pages', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 10), inv(2, 0), inv(3, 20)],
      2: [inv(4, 0), inv(5, 30)],
    }));

    
    const out: any = await list_unpaid_invoices.handler(env, { page: 2, pageSize: 2 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([5]);
  });
});
