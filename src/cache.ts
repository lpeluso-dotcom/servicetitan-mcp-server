import type { Env } from './env';
import { currentBudget, stage, pause, checkDeadline } from './request-budget';
import { hashArgs } from './write-gate';
import { McpError } from './errors';

interface CacheRow {
  value: string;
  expires_at: number;
}

export async function cacheGet<T>(
  env: Env,
  namespace: string,
  key: string,
  ttlSec: number,
  miss: () => Promise<T>
): Promise<T> {
  const budget = currentBudget();
  if (budget) key = await hashArgs({ scope: budget.scope, key });
  if (ttlSec <= 0) {
    return miss();
  }

  try {
    const row = await stage('cache', () => env.DB.prepare(
      `SELECT value, expires_at FROM mcp_cache WHERE ns = ? AND k = ?`
    )
      .bind(namespace, key)
      .first<CacheRow>());

    const now = Date.now();
    if (row && row.expires_at > now) {
      if (budget) budget.stages.cache_hit = 1;
      return JSON.parse(row.value) as T;
    }
  } catch (e) {
    
    
    if (budget) budget.stages.cache_failure = (budget.stages.cache_failure ?? 0) + 1;
    if (namespace.includes('report')) throw new McpError('rate_limited', 'Report cache unavailable; retry later');
  }

  if (budget) budget.stages.cache_miss = 1;
  let owner: string | undefined;
  if (budget) {
    owner = crypto.randomUUID();
    for (let attempt = 0; attempt < 120; attempt++) {
      checkDeadline();
      const claim = await env.DB.prepare(`INSERT INTO mcp_cache_flights (ns, k, owner, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(ns, k) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE mcp_cache_flights.expires_at < ?`)
        .bind(namespace, key, owner, Date.now() + 650_000, Date.now()).run();
      if (claim.meta?.changes === 1) break;
      budget.stages.coalesced = 1;
      await pause(50);
      const row = await env.DB.prepare('SELECT value, expires_at FROM mcp_cache WHERE ns = ? AND k = ?').bind(namespace, key).first<CacheRow>();
      if (row && row.expires_at > Date.now()) return JSON.parse(row.value) as T;
      if (attempt === 119) throw new McpError('rate_limited', 'Identical request is still running; retry later', { retry_after_ms: 1000 });
    }
  }
  try {
  
  if (owner) {
    const row = await env.DB.prepare('SELECT value, expires_at FROM mcp_cache WHERE ns = ? AND k = ?').bind(namespace, key).first<CacheRow>();
    if (row && row.expires_at > Date.now()) return JSON.parse(row.value) as T;
  }
  const fresh = await miss();
  if (fresh && typeof fresh === 'object' && (fresh as { _partial?: boolean })._partial) return fresh;
  
  
  const serialized = JSON.stringify(fresh);
  if (new TextEncoder().encode(serialized).length > 1_048_576) {
    if (budget) budget.stages.cache_oversize = 1;
    return fresh;
  }

  try {
    if (owner) {
      
      await env.DB.prepare(`INSERT OR REPLACE INTO mcp_cache (ns, k, value, expires_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_cache_flights WHERE ns = ? AND k = ? AND owner = ?)`)
        .bind(namespace, key, serialized, Date.now() + ttlSec * 1000, namespace, key, owner).run();
    } else await env.DB.prepare(
      `INSERT OR REPLACE INTO mcp_cache (ns, k, value, expires_at) VALUES (?, ?, ?, ?)`
    )
      .bind(namespace, key, serialized, Date.now() + ttlSec * 1000)
      .run();
  } catch (e) {
    
    console.error('[cache] write failed');
  }

  return fresh;
  } finally {
    if (owner) await env.DB.prepare('DELETE FROM mcp_cache_flights WHERE ns = ? AND k = ? AND owner = ?').bind(namespace, key, owner).run().catch(() => {});
  }
}

export async function cachePurgeNamespace(env: Env, namespace: string): Promise<void> {
  try {
    if (currentBudget()) await env.DB.prepare('DELETE FROM mcp_cache_flights WHERE ns = ?').bind(namespace).run();
    await env.DB.prepare(`DELETE FROM mcp_cache WHERE ns = ?`).bind(namespace).run();
  } catch (e) {
    
    console.error('[cache] purge failed');
    if (currentBudget()) throw new McpError('verify_unavailable', 'Cache invalidation unavailable; verify with a live read');
  }
}
