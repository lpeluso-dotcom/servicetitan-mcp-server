export const FAMILIES = [
  'crm', 'jpm', 'pricebook', 'memberships', 'dispatch', 'reporting',
  'telecom', 'forms', 'taskmanagement', 'accounting', 'sales', 'inventory',
  'payroll', 'marketing', 'settings', 'schedulingpro',
] as const;

export type Family = string;

export type DenyReason = 'aggregate' | 'family' | 'same_report_within_window';

export interface CheckVerdict {
  allowed: boolean;
  
  retryAfter?: number;

  retryAfterMs?: number;
  reason?: DenyReason;
}

export const ST_DOCUMENTED_CALLS_PER_SECOND = 60;

export const WORKER_QUOTA_FRACTION = 1 / 2;

export const AGGREGATE_WINDOW_MS = 1_000;


export const AGGREGATE_CAP = Math.floor(ST_DOCUMENTED_CALLS_PER_SECOND * WORKER_QUOTA_FRACTION);

export const FAMILY_BURST_FRACTION = 0.6;
export const FAMILY_WINDOW_MS = AGGREGATE_WINDOW_MS;
export const DEFAULT_FAMILY_CAP = Math.floor(AGGREGATE_CAP * FAMILY_BURST_FRACTION);


export function capForFamily(_family: string): number {
  return DEFAULT_FAMILY_CAP;
}

export interface RateLimiterConfig {
  aggregateCap: number;
  familyCap: number;
}

export function rateLimiterConfig(env?: { ST_RATE_LIMIT_PER_SEC?: string | number }): RateLimiterConfig {
  const raw = env?.ST_RATE_LIMIT_PER_SEC;
  const parsed =
    typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim())
    : NaN;
  const aggregateCap =
    Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, ST_DOCUMENTED_CALLS_PER_SECOND) : AGGREGATE_CAP;
  return { aggregateCap, familyCap: Math.max(1, Math.floor(aggregateCap * FAMILY_BURST_FRACTION)) };
}

export const IDENTITY_WINDOW_MS = 60_000;

export const MAX_TRACKED_IDENTITIES = 512;

const BACKOFF_MIN_PENALTY_MS = 60_000;

interface FamilyState {
  count: number;
  windowStart: number;
  halvedUntil: number;
}

interface PersistedState {
  families: [string, FamilyState][];
  aggregateCount: number;
  aggregateWindowStart: number;
  
  identities?: [string, number][];
}

export class StRateLimiter {
  private state: DurableObjectState;
  private families: Map<Family, FamilyState> = new Map();
  private identities: Map<string, number> = new Map();
  private aggregateCount = 0;
  private aggregateWindowStart = Date.now();

  private readonly config: RateLimiterConfig;

  constructor(state: DurableObjectState, env?: { ST_RATE_LIMIT_PER_SEC?: string }) {
    this.state = state;
    this.config = rateLimiterConfig(env);
    
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<PersistedState>('ratelimit');
      if (stored) {
        this.families = new Map(stored.families as [Family, FamilyState][]);
        this.identities = new Map(stored.identities ?? []);
        this.aggregateCount = stored.aggregateCount;
        this.aggregateWindowStart = stored.aggregateWindowStart;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<{ family: Family; identity?: string; retryAfter?: number }>();
    const family = body.family;

    let result: unknown;
    if (url.pathname === '/check') {
      result = this.check(family, body.identity);
    } else if (url.pathname === '/backoff') {
      const retryAfterSeconds = Number(body.retryAfter);
      this.applyBackoff(family, isNaN(retryAfterSeconds) ? 60 : retryAfterSeconds);
      result = { ok: true };
    } else {
      return Response.json({ error: 'unknown path' }, { status: 404 });
    }

    
    await this.persistState();
    return Response.json(result);
  }

  private async persistState(): Promise<void> {
    const data: PersistedState = {
      families: Array.from(this.families.entries()),
      aggregateCount: this.aggregateCount,
      aggregateWindowStart: this.aggregateWindowStart,
      identities: Array.from(this.identities.entries()),
    };
    await this.state.storage.put('ratelimit', data);
  }

  private getFamily(family: Family): FamilyState {
    if (!this.families.has(family)) {
      this.families.set(family, { count: 0, windowStart: Date.now(), halvedUntil: 0 });
    }
    return this.families.get(family)!;
  }

  
  private pruneIdentities(now: number): void {
    for (const [key, seenAt] of this.identities) {
      if (now - seenAt >= IDENTITY_WINDOW_MS) this.identities.delete(key);
    }
    if (this.identities.size <= MAX_TRACKED_IDENTITIES) return;
    const byAge = Array.from(this.identities.entries()).sort((a, b) => a[1] - b[1]);
    for (const [key] of byAge.slice(0, this.identities.size - MAX_TRACKED_IDENTITIES)) {
      this.identities.delete(key);
    }
  }

  private check(family: Family, identity?: string): CheckVerdict {
    const now = Date.now();

    if (identity !== undefined) {
      this.pruneIdentities(now);
      const seenAt = this.identities.get(identity);
      if (seenAt !== undefined && now - seenAt < IDENTITY_WINDOW_MS) {
        const remainingMs = seenAt + IDENTITY_WINDOW_MS - now;
        return {
          allowed: false,
          retryAfter: Math.ceil(remainingMs / 1000),
          retryAfterMs: remainingMs,
          reason: 'same_report_within_window',
        };
      }
    }

    if (now - this.aggregateWindowStart >= AGGREGATE_WINDOW_MS) {
      this.aggregateCount = 0;
      this.aggregateWindowStart = now;
    }

    if (this.aggregateCount >= this.config.aggregateCap) {
      const remainingMs = this.aggregateWindowStart + AGGREGATE_WINDOW_MS - now;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
        retryAfterMs: Math.max(1, remainingMs),
        reason: 'aggregate',
      };
    }

    const fs = this.getFamily(family);

    if (now - fs.windowStart >= FAMILY_WINDOW_MS) {
      fs.count = 0;
      fs.windowStart = now;
    }

    const declared = this.config.familyCap;
    
    
    const cap = now < fs.halvedUntil ? Math.max(1, Math.floor(declared / 2)) : declared;

    if (fs.count >= cap) {
      const remainingMs = fs.windowStart + FAMILY_WINDOW_MS - now;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
        retryAfterMs: Math.max(1, remainingMs),
        reason: 'family',
      };
    }

    fs.count++;
    this.aggregateCount++;
    if (identity !== undefined) this.identities.set(identity, now);
    return { allowed: true };
  }

  private applyBackoff(family: Family, retryAfterSeconds: number): void {
    const fs = this.getFamily(family);
    const penaltyMs = Math.max(retryAfterSeconds * 1000, BACKOFF_MIN_PENALTY_MS);
    fs.halvedUntil = Math.max(fs.halvedUntil, Date.now() + penaltyMs);
  }
}
