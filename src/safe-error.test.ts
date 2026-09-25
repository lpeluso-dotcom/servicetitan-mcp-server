import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeError } from './safe-error';
import { McpError } from './errors';
import type { Env } from './env';

const ENV = {} as Env;

describe('safeError — config errors pass through clearly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a config_error message through verbatim, instead of the generic upstream_error text', () => {
    const err = new McpError('config_error', 'ST_APP_KEY is not configured; set it with: wrangler secret put ST_APP_KEY');
    const out = safeError(ENV, err, 'corr-1');
    expect(out.code).toBe('config_error');
    expect(out.message).toBe('ST_APP_KEY is not configured; set it with: wrangler secret put ST_APP_KEY');
  });

  it('still replaces an upstream_error message with the generic text (unchanged behavior)', () => {
    const err = new McpError('upstream_error', 'ServiceTitan OAuth token request failed: HTTP 500');
    const out = safeError(ENV, err, 'corr-2');
    expect(out.code).toBe('upstream_error');
    expect(out.message).toBe('Request failed (upstream_error); use the correlation ID for investigation');
  });

  it('scrubs a secret VALUE out of a config_error message even though the code now passes through', () => {
    const env = { MCP_TOKEN: 'super-secret-value-123' } as unknown as Env;
    const err = new McpError('config_error', 'unexpected token super-secret-value-123 in config');
    const out = safeError(env, err, 'corr-3');
    expect(out.message).not.toContain('super-secret-value-123');
  });

  it('console.error()s a config_error message so `wrangler tail` shows it without waiting on the MCP response', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new McpError('config_error', 'CONFIRMATION_SIGNING_KEY is not configured; set it with: wrangler secret put CONFIRMATION_SIGNING_KEY');
    safeError(ENV, err, 'corr-4');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('CONFIRMATION_SIGNING_KEY is not configured'));
  });

  it('does NOT console.error() for a non-config error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeError(ENV, new McpError('upstream_error', 'HTTP 500'), 'corr-5');
    expect(spy).not.toHaveBeenCalled();
  });

  it('console.error()s the SCRUBBED config_error message, not the raw one, when the message carries a secret-looking env value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { MCP_TOKEN: 'super-secret-value-456' } as unknown as Env;
    const err = new McpError('config_error', 'bad config near token super-secret-value-456');
    const out = safeError(env, err, 'corr-6');
    expect(out.message).not.toContain('super-secret-value-456');
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('super-secret-value-456');
  });
});
