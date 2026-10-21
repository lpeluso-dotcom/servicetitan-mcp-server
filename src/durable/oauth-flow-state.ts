// ============================================================
// OAuthFlowState: strongly consistent, short-lived OAuth relay state.
//
// Login and consent state must be visible immediately across the Access
// callback, the consent-page GET, and the consent POST. Workers KV is
// eventually consistent across locations, so a fresh state can be missing at
// the next edge. One SQLite-backed Durable Object per opaque state value gives
// global routing and atomic single-use consumption.
// ============================================================

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

export type OAuthFlowStateKind = 'login' | 'approve';

export class OAuthFlowState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureTable();
  }

  // deleteAll() drops the table along with everything else, and the
  // constructor does not run again for a live instance. Every method recreates
  // it first, so a retry after a consume reads "no state", not "no such table".
  private ensureTable(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_flow_state (
        kind TEXT PRIMARY KEY CHECK (kind IN ('login', 'approve')),
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async putState(kind: OAuthFlowStateKind, payload: string, expiresAt: number): Promise<void> {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_flow_state (kind, payload, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      kind,
      payload,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
  }

  readState(kind: OAuthFlowStateKind, now: number): string | null {
    this.ensureTable();
    const row = this.ctx.storage.sql.exec<{ payload: string; expires_at: number }>(
      'SELECT payload, expires_at FROM oauth_flow_state WHERE kind = ?',
      kind,
    ).toArray()[0];
    if (!row) return null;
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec('DELETE FROM oauth_flow_state WHERE kind = ?', kind);
      return null;
    }
    return row.payload;
  }

  async consumeState(kind: OAuthFlowStateKind, now: number): Promise<string | null> {
    this.ensureTable();
    // No await between the read and the delete. Durable Object execution is
    // single-threaded, so concurrent callback or approval retries cannot both
    // consume the same state.
    const row = this.ctx.storage.sql.exec<{ payload: string; expires_at: number }>(
      'SELECT payload, expires_at FROM oauth_flow_state WHERE kind = ?',
      kind,
    ).toArray()[0];
    if (!row) return null;
    this.ctx.storage.sql.exec('DELETE FROM oauth_flow_state WHERE kind = ?', kind);
    // The state is single use, so nothing in this object is needed again.
    // Clear it all rather than leave an empty object behind per sign-in.
    await this.ctx.storage.deleteAll();
    return row.expires_at > now ? row.payload : null;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
