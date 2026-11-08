import type { Env } from './env';
import { McpError } from './errors';
import { currentBudget } from './request-budget';

// Cross-worker exclusion for overlapping writes to the same object. This does not
// lock ServiceTitan's UI or other integrations. Lease exceeds the request budget.
export async function withWriteLease<T>(env: Env, resource: string, run: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const expiry = Math.max(now + 300_000, (currentBudget()?.deadline ?? now) + 60_000);
  const claim = await env.DB.prepare(
    'INSERT INTO mcp_cache_flights (ns, k, owner, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, k) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE mcp_cache_flights.expires_at <= ?',
  ).bind('write-lock', resource, owner, expiry, now).run();
  if (claim.meta?.changes !== 1) {
    throw new McpError('rate_limited', 'Another write to this object is in progress. Recheck its state and preview again.', { retry_after_ms: 1000 });
  }
  try { return await run(); }
  finally {
    await env.DB.prepare('DELETE FROM mcp_cache_flights WHERE ns = ? AND k = ? AND owner = ?')
      .bind('write-lock', resource, owner).run();
  }
}
