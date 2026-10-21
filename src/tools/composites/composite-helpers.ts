// ============================================================
// composite-helpers.ts: fanout helpers for composite tools.
//
// Fans a set of named ServiceTitan reads out in parallel and reports
// per-call failures instead of throwing, so one failing read yields a
// partial result rather than losing the whole answer:
//
//   { results: {name: data | null}, partial: bool, failures: [...], truncated: [...] }
// ============================================================

import type { Env } from '../../env';
import { backendRead } from '../../backend';
import { guardedStFetch } from '../../rate-limit-guard';
import { rewriteTenantPlaceholders } from '../../tenant';

export interface FanoutFailure {
  call: string;
  error_class: string;
  message: string;
}

export interface FanoutResult<T = unknown> {
  results: Record<string, T | null>;
  partial: boolean;
  failures: FanoutFailure[];
}

export interface NamedCall {
  name: string;
  promise: Promise<Response>;
}

function tagged(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * A ServiceTitan read routed through `guardedStFetch`, so a composite fanout
 * consults the family rate limiter instead of firing raw parallel calls that
 * ignore the cap. The family is parsed from the tenant-resolved endpoint, the
 * same gate every single-fetch read uses.
 */
export function stReadGuarded(
  env: Env,
  headers: Record<string, string>,
  endpoint: string,
  signal?: AbortSignal,
): Promise<Response> {
  const resolved = rewriteTenantPlaceholders(env, endpoint);
  return guardedStFetch(env, resolved, () =>
    backendRead(env, resolved, signal ? { headers, signal } : { headers }),
  );
}

/** Read the `data` payload and ServiceTitan's top-level `hasMore` flag from a list response. */
function extractStPage<T = unknown>(json: unknown): { data: T; hasMore: boolean } {
  if (json !== null && typeof json === 'object') {
    const obj = json as { data?: T; hasMore?: boolean };
    if ('data' in obj) return { data: obj.data as T, hasMore: obj.hasMore === true };
  }
  return { data: json as T, hasMore: false };
}

/**
 * Fan out a set of reads in parallel and collect results, attributing any
 * failure to the responsible call by name. JSON parsing happens inside the
 * promise chain, so parse errors land in the same rejection path as network
 * and HTTP failures.
 *
 * `results` holds each arm's `.data` (null for a failed arm). `truncated` names
 * every arm whose response carried `hasMore: true`, so a caller can disclose an
 * incomplete answer instead of serving page one as the whole set. A failed arm
 * never appears in `truncated`: only a successful arm can be observed to have
 * more pages.
 */
export async function gatherFetchesWithTruncation(
  calls: NamedCall[],
): Promise<FanoutResult & { truncated: string[] }> {
  const settled = await Promise.allSettled(
    calls.map(async (c) => {
      const resp = await c.promise;
      if (!resp.ok) {
        throw tagged('HTTPError', `${resp.status} ${resp.statusText || ''}`.trim());
      }
      try {
        return extractStPage((await resp.json()) as unknown);
      } catch (e) {
        throw tagged('JSONParseError', e instanceof Error ? e.message : String(e));
      }
    }),
  );

  const results: Record<string, unknown> = {};
  const failures: FanoutFailure[] = [];
  const truncated: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const name = calls[i].name;
    const res = settled[i];
    if (res.status === 'fulfilled') {
      results[name] = res.value.data;
      if (res.value.hasMore) truncated.push(name);
    } else {
      results[name] = null;
      const err = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
      failures.push({
        call: name,
        error_class: err.name || 'Error',
        message: err.message || String(res.reason),
      });
    }
  }

  return { results, partial: failures.length > 0, failures, truncated };
}
