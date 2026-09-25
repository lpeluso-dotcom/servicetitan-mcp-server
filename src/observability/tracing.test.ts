import { describe, it, expect, vi } from 'vitest';
import { traceTool } from './tracing';

function fakeD1(throwOnRun = false) {
  const rows: any[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              if (throwOnRun) throw new Error('d1 down');
              rows.push({ sql, args });
            },
          };
        },
      };
    },
  } as any;
  return { DB, rows };
}

describe('traceTool', () => {
  it('writes exactly one ok root span with the operation/attrs/status when fn resolves ok, using the REAL caller actor (not a hardcoded default)', async () => {
    const { DB, rows } = fakeD1();

    const attrs = { correlation: 'c-123', role: 'default', actor: 'voice-agent', partial: false };

    await traceTool(
      { DB },
      'search_pricebook_services',
      'voice-agent',
      attrs,
      async () => ({ status: 'ok', latencyMs: 42 })
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[3]).toBeNull(); 
    expect(row.args[4]).toBe('servicetitan-mcp-server'); 
    expect(row.args[5]).toBe('search_pricebook_services'); 
    expect(row.args[6]).toBe('voice-agent'); 
    expect(row.args[7]).toBe('interactive'); 
    expect(row.args[8]).toBe('ok'); 
    expect(row.args[9]).toBe(42); 
    expect(JSON.parse(row.args[10])).toEqual(attrs); 
  });

  it('writes exactly one error root span when fn resolves with status error, using the REAL caller actor (not a hardcoded default)', async () => {
    const { DB, rows } = fakeD1();
    const attrs = { correlation: 'c-456', role: 'admin', actor: 'automation-x', code: 'upstream_error' };

    await traceTool(
      { DB },
      'book_job',
      'automation-x',
      attrs,
      async () => ({ status: 'error', latencyMs: 7 })
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[6]).toBe('automation-x'); 
    expect(row.args[3]).toBeNull();
    expect(row.args[8]).toBe('error');
    expect(row.args[9]).toBe(7);
    expect(JSON.parse(row.args[10])).toEqual(attrs);
  });

  it('never throws even when the inner fn itself throws, and still emits an error span with the real caller actor', async () => {
    const { DB, rows } = fakeD1();
    const attrs = { correlation: 'c-789', role: 'default', actor: 'voice-agent' };

    await expect(
      traceTool({ DB }, 'get_customer', 'voice-agent', attrs, async () => {
        throw new Error('unexpected fn throw');
      })
    ).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[6]).toBe('voice-agent'); 
    expect(row.args[8]).toBe('error');
    const parsedAttrs = JSON.parse(row.args[10]);
    expect(parsedAttrs).toMatchObject(attrs);
    expect(parsedAttrs.error).toBe('unexpected fn throw');
  });

  it('is fail-open: a D1 write failure never escapes traceTool, even on the ok path', async () => {
    const { DB } = fakeD1(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      traceTool({ DB }, 'get_job', 'voice-agent', {}, async () => ({ status: 'ok', latencyMs: 1 }))
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });

  it('is fail-open: a D1 write failure never escapes traceTool even when fn also throws', async () => {
    const { DB } = fakeD1(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      traceTool({ DB }, 'get_job', 'voice-agent', {}, async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
