import { describe, it, expect } from 'vitest';
import { resolveSigningKey } from './write-gate';

describe('resolveSigningKey', () => {
  it('uses CONFIRMATION_SIGNING_KEY when set', () => {
    expect(resolveSigningKey({ CONFIRMATION_SIGNING_KEY: 'sign-key' })).toBe('sign-key');
  });

  it('throws a clear config_error when it is unset', () => {
    expect(() => resolveSigningKey({})).toThrow(
      expect.objectContaining({
        code: 'config_error',
        message: expect.stringContaining('CONFIRMATION_SIGNING_KEY'),
      }),
    );
  });

  it('throws when CONFIRMATION_SIGNING_KEY is an empty string', () => {
    expect(() => resolveSigningKey({ CONFIRMATION_SIGNING_KEY: '' })).toThrow(/CONFIRMATION_SIGNING_KEY/);
  });
});
