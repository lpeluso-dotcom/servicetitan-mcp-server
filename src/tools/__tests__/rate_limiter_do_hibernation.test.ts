import { describe, it, expect, vi } from 'vitest';
import { StRateLimiter } from '../../durable/st-rate-limiter';

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    map: m,
    get: vi.fn(async <T = unknown>(k: string) => m.get(k) as T),
    put: vi.fn(async (k: string, v: unknown) => {
      m.set(k, v);
    }),
    delete: vi.fn(async (k: string) => m.delete(k)),
  };
}

function makeDOState(storage: ReturnType<typeof makeStorage>): any {
  return {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  };
}

async function checkCall(rl: StRateLimiter, family: string) {
  const req = new Request('https://do/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family }),
  });
  return rl.fetch(req).then((r) => r.json<{ allowed: boolean; retryAfter?: number }>());
}

async function backoffCall(rl: StRateLimiter, family: string, retryAfter: number) {
  const req = new Request('https://do/backoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family, retryAfter }),
  });
  return rl.fetch(req).then((r) => r.json<{ ok: boolean }>());
}

describe('StRateLimiter — hibernation safety', () => {
  it('persists counter state to DO storage on every check', async () => {
    const storage = makeStorage();
    const rl = new StRateLimiter(makeDOState(storage));

    const r1 = await checkCall(rl, 'crm');
    expect(r1.allowed).toBe(true);
    expect(storage.put).toHaveBeenCalledWith('ratelimit', expect.objectContaining({
      aggregateCount: 1,
    }));

    await checkCall(rl, 'crm');
    await checkCall(rl, 'jpm');

    const stored: any = storage.map.get('ratelimit');
    expect(stored.aggregateCount).toBe(3);
    const familyCounts = Object.fromEntries(stored.families);
    expect(familyCounts.crm.count).toBe(2);
    expect(familyCounts.jpm.count).toBe(1);
  });

  it('rehydrates counter state across simulated eviction', async () => {
    const storage = makeStorage();

    
    const rl1 = new StRateLimiter(makeDOState(storage));
    for (let i = 0; i < 5; i++) await checkCall(rl1, 'crm');

    const rl2 = new StRateLimiter(makeDOState(storage));

    const next = await checkCall(rl2, 'crm');
    expect(next.allowed).toBe(true);

    const stored: any = storage.map.get('ratelimit');
    
    expect(stored.aggregateCount).toBe(6);
    const familyCounts = Object.fromEntries(stored.families);
    expect(familyCounts.crm.count).toBe(6);
  });

  it('rehydrates halvedUntil backoff across eviction', async () => {
    const storage = makeStorage();

    const rl1 = new StRateLimiter(makeDOState(storage));
    await backoffCall(rl1, 'pricebook', 30);

    const rl2 = new StRateLimiter(makeDOState(storage));
    
    
    let lastResult: { allowed: boolean; retryAfter?: number } | null = null;
    for (let i = 0; i < 16; i++) {
      lastResult = await checkCall(rl2, 'pricebook');
      if (!lastResult.allowed) break;
    }
    
    
    const stored: any = storage.map.get('ratelimit');
    const families = new Map(stored.families);
    const pricebook = families.get('pricebook') as { halvedUntil: number };
    expect(pricebook.halvedUntil).toBeGreaterThan(0);
  });

  it('starts clean when storage is empty', async () => {
    const storage = makeStorage();
    const rl = new StRateLimiter(makeDOState(storage));

    const r = await checkCall(rl, 'crm');
    expect(r.allowed).toBe(true);
    const stored: any = storage.map.get('ratelimit');
    expect(stored.aggregateCount).toBe(1);
  });

  it('serves 404 on unknown path without persisting state', async () => {
    const storage = makeStorage();
    const rl = new StRateLimiter(makeDOState(storage));
    const req = new Request('https://do/unknown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family: 'crm' }),
    });
    const resp = await rl.fetch(req);
    expect(resp.status).toBe(404);
    expect(storage.map.has('ratelimit')).toBe(false);
  });
});
