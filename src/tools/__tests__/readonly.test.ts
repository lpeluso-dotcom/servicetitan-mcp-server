import { describe, it, expect, vi } from 'vitest';
import { WriteGate } from '../../write-gate';

describe('dev read-only gate', () => {
  it('allows a local preview but blocks confirmation before token consumption or proxy fetch', async () => {
    const run = vi.fn(async () => ({}));
    const prepare = vi.fn(() => ({ bind: () => ({ run }) }));
    const proxy = vi.fn();
    const env = { READONLY: '1', LEGACY_TEST_KEY: 'test-key', CONFIRMATION_SIGNING_KEY: 'test-key', ST_TENANT_ID: '123',
      DB: { prepare }, ST_TRANSPORT: { fetch: proxy } } as never;
    const gate = new WriteGate(env);
    const preview = await gate.dryRun('example', {}, 'test', 'corr', {}, '/x', 'PATCH');
    expect(preview.dryRun).toBe(true);
    prepare.mockClear();
    await expect(gate.verifyToken('example', {}, 'test', preview.confirmation_token))
      .rejects.toThrow(/read.only/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });
});
