import { describe, it, expect, vi, afterEach } from 'vitest';
import { StRateLimiter, rateLimiterConfig } from '../st-rate-limiter';

function makeState(): any {
  const m = new Map<string, unknown>();
  return {
    storage: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v) },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
}

async function check(rl: StRateLimiter, family: string) {
  const resp = await rl.fetch(new Request('https://do/check', { method: 'POST', body: JSON.stringify({ family }) }));
  return resp.json<{ allowed: boolean; reason?: string }>();
}

afterEach(() => vi.useRealTimers());

describe('rateLimiterConfig', () => {
  it('parses, defaults, and clamps', () => {
    expect(rateLimiterConfig()).toEqual({ aggregateCap: 30, familyCap: 18 });
    expect(rateLimiterConfig({})).toEqual({ aggregateCap: 30, familyCap: 18 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: '60' })).toEqual({ aggregateCap: 60, familyCap: 36 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: ' 30 ' })).toEqual({ aggregateCap: 30, familyCap: 18 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: '120' })).toEqual({ aggregateCap: 60, familyCap: 36 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: '0' })).toEqual({ aggregateCap: 30, familyCap: 18 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: 'fast' })).toEqual({ aggregateCap: 30, familyCap: 18 });
    expect(rateLimiterConfig({ ST_RATE_LIMIT_PER_SEC: '1' })).toEqual({ aggregateCap: 1, familyCap: 1 });
  });
});

describe('StRateLimiter with env', () => {
  it('admits 60 calls in one second at ST_RATE_LIMIT_PER_SEC=60, then denies on aggregate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const rl = new StRateLimiter(makeState(), { ST_RATE_LIMIT_PER_SEC: '60' });
    const families = ['crm', 'jpm', 'pricebook'];
    for (let i = 0; i < 60; i++) expect((await check(rl, families[i % 3])).allowed).toBe(true);
    expect(await check(rl, 'sales')).toMatchObject({ allowed: false, reason: 'aggregate' });
  });

  it('caps one family at 60% of the configured budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const rl = new StRateLimiter(makeState(), { ST_RATE_LIMIT_PER_SEC: '60' });
    for (let i = 0; i < 36; i++) expect((await check(rl, 'crm')).allowed).toBe(true);
    expect(await check(rl, 'crm')).toMatchObject({ allowed: false, reason: 'family' });
  });

  it('keeps the default 30/s budget when no env is passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const rl = new StRateLimiter(makeState());
    for (let i = 0; i < 30; i++) expect((await check(rl, i % 2 ? 'crm' : 'jpm')).allowed).toBe(true);
    expect(await check(rl, 'sales')).toMatchObject({ allowed: false, reason: 'aggregate' });
  });
});
