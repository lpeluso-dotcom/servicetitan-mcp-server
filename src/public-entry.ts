import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { PUBLIC_TOOLS } from './tools/public-registry';
import { filterToolsForRole } from './tools/role-filter';
import { registerTool, type RequestContext } from './tool-registry';
import { registerResultResource } from './resources/results';
import { compactToolListOnWire } from './tool-list-compact';
import { createOAuthProvider, handleOAuthRoute } from './oauth';
import { isOAuthConfigured } from './oauth-config';
import { resolvePublicAuth } from './public-auth';
import { corsOptionsFor } from './cors';
import { backendName } from './backend';

export { StRateLimiter } from './durable/st-rate-limiter';

export const PUBLIC_SERVICE_NAME = 'servicetitan-mcp-server';

export const PUBLIC_INSTRUCTIONS = [
  'ServiceTitan MCP server for one ServiceTitan tenant, using the ServiceTitan public API.',
  'Writes take two calls: first dryRun=true (the default) returns a preview and a confirmation_token; then call again with dryRun=false and that token.',
  'If a write outcome is unknown, call st_operation_status; never resubmit the write.',
  'A zero or blank price can mean ServiceTitan prices the item dynamically; never call it free or unpriced.',
  'Large results are paged: follow get_result_page until next_cursor is null.',
].join('\n');

function safeBackendName(env: Env): string {
  try {
    return backendName(env);
  } catch {
    return 'invalid';
  }
}

function resolvePublicBackendEnv(env: Env): Env {
  return env.ST_BACKEND ? env : { ...env, ST_BACKEND: 'direct' };
}

export const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_DELETE_BATCH = 500;

const RETENTION_WALL_CLOCK_BUDGET_MS = 20_000;

interface RetentionRule {
  table: string;
  
  column: 'expires_at' | 'ts' | 'created_at' | 'updated_at';
  idColumn: 'rowid' | 'id';
}

const RETENTION_RULES: readonly RetentionRule[] = [
  
  { table: 'mcp_result_pages', column: 'expires_at', idColumn: 'rowid' },
  { table: 'mcp_cache', column: 'expires_at', idColumn: 'rowid' },
  { table: 'confirmation_tokens', column: 'expires_at', idColumn: 'rowid' },
  { table: 'mcp_cache_flights', column: 'expires_at', idColumn: 'rowid' },
  { table: 'mcp_report_runs', column: 'expires_at', idColumn: 'id' },
  
  { table: 'audit_log', column: 'ts', idColumn: 'id' },
  { table: 'error_log', column: 'ts', idColumn: 'id' },
  { table: 'otel_span_queue', column: 'ts', idColumn: 'id' },
  { table: 'mcp_operations', column: 'created_at', idColumn: 'id' },

  { table: 'mcp_report_queries', column: 'updated_at', idColumn: 'rowid' },
];

function retentionCutoffMs(env: Pick<Env, 'RETENTION_DAYS'>, now: number): number {
  const parsed = Number(env.RETENTION_DAYS);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return now - days * 24 * 60 * 60 * 1000;
}

async function runDelete(env: Env, sql: string, bound: unknown): Promise<number> {
  const res = await env.DB.prepare(sql).bind(bound, RETENTION_DELETE_BATCH).run();
  return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

async function deleteInBatches(env: Env, table: string, idColumn: string, column: string, bound: number, deadline: number): Promise<number> {
  const sql = `DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${column} < ? LIMIT ?)`;
  let total = 0;
  while (Date.now() < deadline) {
    const changes = await runDelete(env, sql, bound);
    total += changes;
    if (changes < RETENTION_DELETE_BATCH) break;
  }
  return total;
}

async function deleteOrphanedConfirmationOwners(env: Env, deadline: number): Promise<number> {
  const sql =
    'DELETE FROM mcp_confirmation_owners WHERE token_hash IN ' +
    '(SELECT token_hash FROM mcp_confirmation_owners WHERE token_hash NOT IN (SELECT token_hash FROM confirmation_tokens) LIMIT ?)';
  let total = 0;
  while (Date.now() < deadline) {
    const res = await env.DB.prepare(sql).bind(RETENTION_DELETE_BATCH).run();
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
    total += changes;
    if (changes < RETENTION_DELETE_BATCH) break;
  }
  return total;
}

export async function cleanupExpiredRows(env: Env, now: number = Date.now()): Promise<Record<string, number>> {
  const cutoff = retentionCutoffMs(env, now);
  const deadline = Date.now() + RETENTION_WALL_CLOCK_BUDGET_MS;
  const deleted: Record<string, number> = {};
  for (const rule of RETENTION_RULES) {
    const bound = rule.column === 'expires_at' ? now : cutoff;
    deleted[rule.table] = await deleteInBatches(env, rule.table, rule.idColumn, rule.column, bound, deadline);
  }
  deleted.mcp_confirmation_owners = await deleteOrphanedConfirmationOwners(env, deadline);
  return deleted;
}

export function publicHealthPayload(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: PUBLIC_SERVICE_NAME,
    version: env.MCP_SERVICE_VERSION,
    toolCount: PUBLIC_TOOLS.length,
    backend: safeBackendName(env),
    lockdown: env.MCP_LOCKDOWN === 'true',
  };
}

export function buildPublicServer(env: Env, execCtx: ExecutionContext, reqCtx: RequestContext): McpServer {
  const server = new McpServer(
    { name: PUBLIC_SERVICE_NAME, version: env.MCP_SERVICE_VERSION },
    { instructions: PUBLIC_INSTRUCTIONS },
  );
  const visible = filterToolsForRole(PUBLIC_TOOLS, reqCtx.role);
  const scoped: RequestContext = { ...reqCtx, availableTools: visible.map((t) => t.name) };
  for (const tool of visible) registerTool(server, tool, env, execCtx, scoped);
  compactToolListOnWire(server);
  registerResultResource(server, env, scoped);
  return server;
}

function unauthorized(request: Request): Response {
  const cors = corsOptionsFor(request);
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'POST /mcp requires Authorization: Bearer <MCP_TOKEN>.' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': cors.origin,
        'access-control-allow-methods': cors.methods,
        'access-control-allow-headers': cors.headers,
        'access-control-expose-headers': cors.exposeHeaders,
        vary: 'origin',
      },
    },
  );
}

const OAUTH_DANCE_PATHS: ReadonlySet<string> = new Set(['/authorize', '/callback', '/approve', '/token', '/register']);
function isOAuthDancePath(pathname: string): boolean {
  return OAUTH_DANCE_PATHS.has(pathname) || pathname === '/mcp-oauth' || pathname.startsWith('/mcp-oauth/');
}

function oauthNotConfigured(request: Request): Response {
  const cors = corsOptionsFor(request);
  return new Response(JSON.stringify({ error: 'oauth_not_configured' }), {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': cors.origin,
      'access-control-allow-methods': cors.methods,
      'access-control-allow-headers': cors.headers,
      'access-control-expose-headers': cors.exposeHeaders,
      vary: 'origin',
    },
  });
}

async function tokenFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  env = resolvePublicBackendEnv(env);
  const url = new URL(request.url);
  if (url.pathname === '/health' || (url.pathname === '/' && request.method === 'GET')) {
    return Response.json(publicHealthPayload(env));
  }
  if (env.OAUTH_KV) {
    if (!isOAuthConfigured(env)) {
      if (isOAuthDancePath(url.pathname)) return oauthNotConfigured(request);
    } else {
      const oauthRoute = await handleOAuthRoute(request, env, url);
      if (oauthRoute) return oauthRoute;
    }
  }
  if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const auth = request.method === 'OPTIONS'
    ? { authenticated: true, role: 'default' as const, actor: 'preflight', principal: undefined }
    : await resolvePublicAuth(request, env);
  if (!auth.authenticated) return unauthorized(request);
  const reqCtx: RequestContext = { actor: auth.actor, role: auth.role, principal: auth.principal, signal: request.signal };
  const server = buildPublicServer(env, ctx, reqCtx);
  return createMcpHandler(server, { route: '/mcp', corsOptions: corsOptionsFor(request) })(request, env, ctx);
}


const oauthApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = resolvePublicBackendEnv(env);
    const props = (ctx as unknown as { props?: { email?: string } }).props;
    if (!props?.email) return unauthorized(request);
    const reqCtx: RequestContext = {
      actor: props.email,
      principal: `oauth:${props.email.toLowerCase()}`,
      role: env.MCP_LOCKDOWN === 'true' ? 'lockdown' : 'readonly',
      signal: request.signal,
    };
    const server = buildPublicServer(env, ctx, reqCtx);
    return createMcpHandler(server, { route: '/mcp-oauth', corsOptions: corsOptionsFor(request) })(request, env, ctx);
  },
};

const oauthProvider = createOAuthProvider(tokenFetch, oauthApiHandler);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return isOAuthConfigured(env) ? oauthProvider.fetch(request, env, ctx) : tokenFetch(request, env, ctx);
  },
  
  
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(cleanupExpiredRows(env));
  },
} satisfies ExportedHandler<Env>;
