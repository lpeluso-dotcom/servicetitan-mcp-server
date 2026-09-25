import type { Env } from './env';
import type { RequestContext } from './tool-registry';
export function scopeFor(env: Env, ctx: RequestContext): string {
  return JSON.stringify([env.ST_TENANT_ID, ctx.principal ?? 'unidentified', ctx.role]);
}
