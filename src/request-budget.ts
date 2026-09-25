import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './env';
import { McpError } from './errors';
import { checkRateLimit, familyFromEndpoint, reportBackoff, parseRetryAfterSeconds } from './rate-limit-guard';
import { stTransport } from './backend';

export interface RequestBudget {
  signal: AbortSignal;
  deadline: number;
  scope: string;
  upstream: number;
  stages: Record<string, number>;
  submitted: boolean;
  operationId?: string;
  instanceId?: string;
  active: number;
  queue: Array<() => void>;
}
const storage = new AsyncLocalStorage<RequestBudget>();
const quotaStorage = new AsyncLocalStorage<boolean>();
export const withQuotaPermit = <T>(run: () => Promise<T>) => quotaStorage.run(true, run);
export const currentBudget = () => storage.getStore();
export function checkDeadline(): void {
  const b = currentBudget();
  if (b && (b.signal.aborted || Date.now() >= b.deadline)) throw new McpError('timeout', 'Request deadline exceeded');
}
export async function bounded<T>(work: Promise<T>, signal = currentBudget()?.signal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new McpError('timeout', 'Request deadline exceeded'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function pause(ms: number): Promise<void> {
  checkDeadline();
  let timer: ReturnType<typeof setTimeout>;
  try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
  finally { clearTimeout(timer!); }
  checkDeadline();
}
export async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  checkDeadline();
  const start = Date.now();
  try { return await bounded(run()); }
  finally { const b = currentBudget(); if (b) b.stages[name] = (b.stages[name] ?? 0) + Date.now() - start; }
}
export async function readBounded(response: Response, signal = currentBudget()?.signal, maxBytes = 1_048_576): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new McpError('upstream_error', 'Response exceeds the byte limit; narrow the query');
      chunks.push(part.value);
    }
  } catch (e) { void reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}


export async function budgetFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const budget = currentBudget();
  if (!budget) return fetch(input, init);
  checkDeadline();
  if (budget.active >= 6) await bounded(new Promise<void>(resolve => budget.queue.push(resolve)));
  checkDeadline();
  budget.active++;
  try {
    const request = new Request(input, init);
    if (request.body) await readBounded(new Response(request.clone().body), budget.signal, 262_144);
    if (++budget.upstream > 100) throw new McpError('rate_limited', 'Request upstream-call budget exhausted');
    const signal = AbortSignal.any([budget.signal, request.signal]);
    const response = await stage('upstream', () => fetch(request, { signal }));
    const body = await stage('response_read', () => readBounded(response, signal));
    return new Response([204, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally { budget.active--; budget.queue.shift()?.(); }
}


export async function withBudget<T>(env: Env, scope: string, ms: number, run: (scoped: Env, budget: RequestBudget) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const budget: RequestBudget = { signal, deadline: Date.now() + ms, scope, upstream: 0, stages: {}, submitted: false, active: 0, queue: [] };

  let transport: Fetcher;
  try {
    transport = stTransport(env);
  } catch (e) {
    const err = e instanceof McpError ? e : new McpError('upstream_error', e instanceof Error ? e.message : String(e));
    transport = {
      fetch: async () => { throw err; },
      connect: () => { throw new Error('Unavailable'); },
    } as unknown as Fetcher;
  }
  const proxy = new Proxy(transport, { get(target, property) {
    if (property !== 'fetch') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      checkDeadline();
      if (budget.active >= 6) await bounded(new Promise<void>(resolve => budget.queue.push(resolve)));
      checkDeadline();
      budget.active++;
      try {
        const request = new Request(input, init);
        if (request.body) {
          const body = await readBounded(new Response(request.clone().body), signal, 262_144);
          if (new TextEncoder().encode(body).length > 262_144) throw new McpError('validation_error', 'Request too large');
        }
        const url = new URL(request.url);
        const isWrite = /\/api\/st\/write$/.test(url.pathname);
        const consumesQuota = isWrite || url.pathname === '/api/st/read';
        const family = familyFromEndpoint(url.searchParams.get('endpoint') ?? '/pricebook/');
        if (consumesQuota && !quotaStorage.getStore()) await checkRateLimit(env, family);
        checkDeadline();
        budget.upstream++;
        if (budget.upstream > 100) throw new McpError('rate_limited', 'Request upstream-call budget exhausted');
        if (isWrite) budget.submitted = true;
        const response = await stage('upstream', () => target.fetch(request, { signal: AbortSignal.any([signal, request.signal]) }));
        if (response.status === 429 && consumesQuota && !quotaStorage.getStore()) await reportBackoff(env, family, parseRetryAfterSeconds(response.headers.get('Retry-After')));
        
        
        const endpointPath = new URL(url.searchParams.get('endpoint') ?? '/', 'https://proxy-backend').pathname;
        const responseLimit = url.pathname === '/api/st/read' && /\/pricebook\/v2\/tenant\/\d+\/categories$/.test(endpointPath) ? 8_388_608 : 1_048_576;
        const text = await stage('response_read', () => readBounded(response, signal, responseLimit));
        return new Response(response.status === 204 || response.status === 304 ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { budget.active--; budget.queue.shift()?.(); }
    };
  }});
  const database = env.DB && new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      const wrap = (value: D1PreparedStatement): D1PreparedStatement => new Proxy(value, { get(stmt, method) {
        if (method === 'bind') return (...args: unknown[]) => wrap(stmt.bind(...args));
        const fn = Reflect.get(stmt, method);
        if (typeof fn !== 'function') return fn;
        
        if (/^UPDATE mcp_operations SET /i.test(sql) || /^DELETE FROM mcp_cache_flights WHERE ns = \? AND k = \? AND owner = \?/i.test(sql)) return fn.bind(stmt);
        return (...args: unknown[]) => stage('database', () => fn.apply(stmt, args));
      }});
      return wrap(statement);
    };
    const fn = Reflect.get(target, property);
    return typeof fn === 'function' ? fn.bind(target) : fn;
  }});
  try { return await storage.run(budget, () => bounded(run({ ...env, DB: database ?? env.DB, ST_TRANSPORT: proxy }, budget), signal)); }
  finally { clearTimeout(timer); controller.abort(); }
}
