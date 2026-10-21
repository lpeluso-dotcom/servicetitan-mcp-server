import { describe, it, expect } from 'vitest';
import { OAuthFlowState } from '../oauth-flow-state';

// A storage double that understands the few statements OAuthFlowState issues.
// deleteAll() drops the table, as it does in the runtime, and is recorded.
function makeCtx() {
  let table: Map<string, { payload: string; expires_at: number }> | null = null;
  const calls = { deleteAll: 0, setAlarm: [] as number[] };
  const exec = (sql: string, ...args: any[]) => {
    const rows: any[] = [];
    if (/^\s*CREATE TABLE IF NOT EXISTS/i.test(sql)) table ??= new Map();
    else {
      if (!table) throw new Error('no such table: oauth_flow_state');
      if (/^\s*INSERT/i.test(sql)) table.set(args[0], { payload: args[1], expires_at: args[2] });
      else if (/^\s*SELECT/i.test(sql)) { const r = table.get(args[0]); if (r) rows.push(r); }
      else if (/^\s*DELETE FROM oauth_flow_state WHERE kind/i.test(sql)) table.delete(args[0]);
      else if (/^\s*DELETE FROM oauth_flow_state/i.test(sql)) table.clear();
      else throw new Error(`unexpected sql: ${sql}`);
    }
    return { toArray: () => rows };
  };
  const ctx: any = {
    storage: {
      sql: { exec },
      setAlarm: async (t: number) => void calls.setAlarm.push(t),
      deleteAll: async () => { calls.deleteAll++; table = null; },
    },
  };
  return { ctx, calls, hasTable: () => table !== null };
}

describe('OAuthFlowState', () => {
  it('clears all storage after a successful consume', async () => {
    const { ctx, calls, hasTable } = makeCtx();
    const dobj = new OAuthFlowState(ctx, {} as any);
    await dobj.putState('login', '{"a":1}', Date.now() + 60_000);
    expect(await dobj.consumeState('login', Date.now())).toBe('{"a":1}');
    expect(calls.deleteAll).toBe(1);
    expect(hasTable()).toBe(false);
  });

  it('answers a second consume (a retry) with null, not an error, after storage was cleared', async () => {
    const { ctx } = makeCtx();
    const dobj = new OAuthFlowState(ctx, {} as any);
    await dobj.putState('approve', 'x', Date.now() + 60_000);
    await dobj.consumeState('approve', Date.now());
    expect(await dobj.consumeState('approve', Date.now())).toBeNull();
    expect(await dobj.readState('approve', Date.now())).toBeNull();
  });

  it('does not clear storage when there was nothing to consume', async () => {
    const { ctx, calls } = makeCtx();
    const dobj = new OAuthFlowState(ctx, {} as any);
    expect(await dobj.consumeState('login', Date.now())).toBeNull();
    expect(calls.deleteAll).toBe(0);
  });

  it('alarm() clears all storage', async () => {
    const { ctx, calls, hasTable } = makeCtx();
    const dobj = new OAuthFlowState(ctx, {} as any);
    await dobj.putState('login', 'x', Date.now() + 60_000);
    await dobj.alarm();
    expect(calls.deleteAll).toBe(1);
    expect(hasTable()).toBe(false);
  });
});
