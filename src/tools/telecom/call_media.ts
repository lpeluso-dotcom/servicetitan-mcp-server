// Media presence and bounded byte count only. Audio playback stays in ServiceTitan.
import type { Env } from '../../env';
import { backendRead } from '../../backend';
import { authHeaders } from '../../auth';
import { McpError, mapUpstreamStatus } from '../../errors';
import { guardedStFetch, parseRetryAfterSeconds } from '../../rate-limit-guard';
import { rewriteTenantPlaceholders } from '../../tenant';

export type CallMediaKind = 'recording' | 'voicemail';

export interface CallMediaMeta {
  call_id: number;
  kind: CallMediaKind;
  available: boolean;
  status: number;
  content_type: string | null;
  bytes_received: number | null;
  /** Present (true) only when the body exceeded the count cap; bytes_received is then a lower bound. */
  truncated?: true;
  _source: 'live';
}

/** Stop counting after this many bytes (25 MiB). Real call audio is far smaller. */
export const MAX_COUNTED_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024;

/** Stream a body, keeping at most `keep` bytes, counting up to `cap`, then cancel. */
async function drain(resp: Response, cap: number, keep: number): Promise<{ bytes: number; truncated: boolean; head: Uint8Array }> {
  if (!resp.body) return { bytes: 0, truncated: false, head: new Uint8Array(0) };
  const reader = resp.body.getReader();
  const head = new Uint8Array(keep);
  let headLen = 0;
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (headLen < keep) {
        const take = Math.min(keep - headLen, value.byteLength);
        head.set(value.subarray(0, take), headLen);
        headLen += take;
      }
      bytes += value.byteLength;
      if (bytes > cap) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, truncated, head: head.subarray(0, headLen) };
}

export async function fetchCallMediaMeta(
  env: Env,
  ctx: { actor: string; correlation: string },
  callId: number,
  kind: CallMediaKind,
): Promise<CallMediaMeta> {
  const path = rewriteTenantPlaceholders(env, `/telecom/v2/tenant/000000000/calls/${callId}/${kind}`);
  const resp = await guardedStFetch(env, path, () =>
    backendRead(env, path, { headers: authHeaders(env, ctx.correlation, ctx.actor) }),
  );
  if (resp.status === 404) {
    await resp.body?.cancel().catch(() => undefined);
    return { call_id: callId, kind, available: false, status: 404, content_type: null, bytes_received: null, _source: 'live' };
  }
  if (!resp.ok) {
    const { head } = await drain(resp, MAX_ERROR_BODY_BYTES, MAX_ERROR_BODY_BYTES).catch(() => ({ head: new Uint8Array(0) }));
    const body = new TextDecoder().decode(head);
    throw new McpError(mapUpstreamStatus(resp.status), `call media returned HTTP ${resp.status}`, {
      correlation: ctx.correlation,
      // Same as readST: a 429 without retry_after_ms cannot be acted on.
      ...(resp.status === 429
        ? { retry_after_ms: parseRetryAfterSeconds(resp.headers.get('retry-after')) * 1000 }
        : {}),
    });
  }
  let counted: { bytes: number; truncated: boolean };
  try {
    counted = await drain(resp, MAX_COUNTED_BYTES, 0);
  } catch (err) {
    // A stream that dies mid-body must not escape as a raw TypeError.
    throw new McpError('upstream_error', `call media body read failed on ${path}: ${String((err as Error)?.message ?? err).slice(0, 200)}`, {
      correlation: ctx.correlation,
    });
  }
  const { bytes, truncated } = counted;
  return {
    call_id: callId,
    kind,
    // An empty 2xx body is not media.
    available: bytes > 0,
    status: resp.status,
    content_type: resp.headers.get('content-type'),
    bytes_received: bytes,
    ...(truncated ? { truncated: true as const } : {}),
    _source: 'live',
  };
}
