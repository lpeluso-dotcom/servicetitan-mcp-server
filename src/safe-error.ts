import type { Env } from './env';
import { McpError } from './errors';


export function scrubDiagnostics(env: Env, input: unknown): unknown {
  if (Array.isArray(input)) return input.map(value => scrubDiagnostics(env, value));
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    /^(?:_?errors?|_?failures?|diagnostics?|stack)$/i.test(key) ? scrub(env, value) : scrubDiagnostics(env, value),
  ]));
}

export function scrub(env: Env, input: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof input === 'string') {
    let text = input;
    for (const [key, value] of Object.entries(env)) {
      if (!/secret|token|key|password/i.test(key) || typeof value !== 'string' || value.length < 4) continue;
      const variants = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
      try { variants.add(decodeURIComponent(value)); } catch {  }
      try { variants.add(btoa(value)); } catch {  }
      for (const variant of variants) if (variant.length >= 4) text = text.split(variant).join('[redacted]');
    }
    return text.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]').slice(0, 1000);
  }
  if (Array.isArray(input)) return input.slice(0, 20).map(v => scrub(env, v, depth + 1));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).slice(0, 30).map(([k,v]) => [k, /secret|token|authorization|cookie|password/i.test(k) ? '[redacted]' : scrub(env, v, depth + 1)]));
  return input;
}
export function safeError(env: Env, error: unknown, correlation: string): McpError {
  const known = error instanceof McpError;
  const code = known ? error.code : 'internal_error';
  
  const message = known && ['validation_error','rate_limited','not_found','config_error'].includes(code)
    ? String(scrub(env, error.message)) : `Request failed (${code}); use the correlation ID for investigation`;
  if (known && code === 'config_error') {

    console.error(`[config] ${message}`);
  }
  const details = known && error.details && typeof error.details === 'object' ? error.details as Record<string,unknown> : {};
  const recovery = typeof details.operation_id === 'string' && /^[a-f0-9]{64}$/.test(details.operation_id)
    ? { operation_id: details.operation_id, state: details.state } : undefined;
  return new McpError(code, message, { correlation, details: recovery, retry_after_ms: known ? error.retry_after_ms : undefined });
}
