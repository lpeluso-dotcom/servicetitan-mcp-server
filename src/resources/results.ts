import { withBudget } from '../request-budget';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError as SdkMcpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '../errors';
import type { Env } from '../env';
import type { RequestContext } from '../tool-registry';
import { scopeFor } from '../scope';

export const RESULT_THRESHOLD = 80_000;
export const RESULT_TTL_S = 900;
const PAGE_BYTES = 48_000;
const PREVIEW_BYTES = 4_000;
export type ContentBlock = { type: 'text'; text: string } | { type: 'resource_link'; uri: string; name: string; mimeType?: string };
export interface OffloadResult { offloaded: boolean; content: ContentBlock[]; structuredContent: Record<string, unknown> }

interface StoredPage {
  page: number;
  page_count: number;
  encoding: 'row-page' | 'json-text-segment';
  items_path?: string;
  root_fields?: Record<string, unknown>;
  items?: unknown[];
  item_offset?: number;
  item_count?: number;
  total_items?: number;
  segment?: string;
  next_cursor: number | null;
}

const QUALIFICATION_KEY = /(^|_)(source|as.?of|freshness|partial|truncated|total|returned|count|unit|calculation|basis|warning|warnings|failures|window|scope)($|_)/i;
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function wrapStructuredContent(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { result };
}

function qualifications(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!QUALIFICATION_KEY.test(key)) continue;
    if (utf8Bytes(value) <= PREVIEW_BYTES) out[key] = value;
  }
  return out;
}

function largestTopLevelArray(result: unknown): { path: string; items: unknown[]; rootFields?: Record<string, unknown> } | null {
  if (Array.isArray(result)) return { path: '$', items: result };
  if (!result || typeof result !== 'object') return null;
  const candidates = Object.entries(result as Record<string, unknown>)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
  if (candidates.length === 0) return null;
  const [path, items] = candidates.sort((a, b) => utf8Bytes(b[1]) - utf8Bytes(a[1]))[0];
  const rootFields = Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([key]) => key !== path));
  return { path, items, rootFields };
}

function rowPages(path: string, items: unknown[], rootFields?: Record<string, unknown>): StoredPage[] {
  const groups: unknown[][] = [];
  let current: unknown[] = [];
  for (const item of items) {
    if (current.length > 0 && utf8Bytes([...current, item]) > PAGE_BYTES) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0 || groups.length === 0) groups.push(current);
  let offset = 0;
  return groups.map((group, page) => {
    const itemOffset = offset;
    offset += group.length;
    return {
      page,
      page_count: groups.length,
      encoding: 'row-page',
      items_path: path,
      ...(page === 0 && rootFields ? { root_fields: rootFields } : {}),
      items: group,
      item_offset: itemOffset,
      item_count: group.length,
      total_items: items.length,
      next_cursor: page + 1 < groups.length ? page + 1 : null,
    };
  });
}

function storedPages(result: unknown): StoredPage[] {
  const rows = largestTopLevelArray(result);
  if (rows && rows.items.every((item) => utf8Bytes(item) <= PAGE_BYTES) &&
      (!rows.rootFields || utf8Bytes(rows.rootFields) <= PAGE_BYTES)) {
    return rowPages(rows.path, rows.items, rows.rootFields);
  }
  const text = JSON.stringify(result ?? null);
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let low = cursor + 1;
    let high = Math.min(text.length, cursor + PAGE_BYTES);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (new TextEncoder().encode(text.slice(cursor, middle)).length <= PAGE_BYTES) low = middle;
      else high = middle - 1;
    }
    let end = low;
    
    if (end < text.length && end > cursor && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    if (end <= cursor) end = cursor + 1;
    segments.push(text.slice(cursor, end));
    cursor = end;
  }
  return segments.map((segment, page) => ({
    page,
    page_count: segments.length,
    encoding: 'json-text-segment',
    segment,
    next_cursor: page + 1 < segments.length ? page + 1 : null,
  }));
}

function preview(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items.slice(0, 5)) {
    if (utf8Bytes([...out, item]) > PREVIEW_BYTES) break;
    out.push(item);
  }
  return out;
}

export async function offloadIfLarge(env: Env, correlation: string, result: unknown, _hasOutputSchema: boolean, reqCtx?: RequestContext, tool = 'unknown'): Promise<OffloadResult> {
  const text = JSON.stringify(result ?? null);
  const inline: OffloadResult = { offloaded: false, content: [{ type: 'text', text }], structuredContent: wrapStructuredContent(result) };
  if (new TextEncoder().encode(JSON.stringify(inline)).length <= RESULT_THRESHOLD) return inline;
  if (!reqCtx?.principal) throw new McpError('auth_failed', 'Authenticated identity required to store a result');
  const bytes = new TextEncoder().encode(text).length;
  const storageLimit = 1_048_576;
  if (bytes > storageLimit) throw new McpError('validation_error', 'Result exceeds storage budget; narrow filters or request fewer pages');
  const pageValues = storedPages(result);
  const expiresAt = Date.now() + RESULT_TTL_S * 1000;
  const statements = pageValues.map((page) => env.DB.prepare('INSERT INTO mcp_result_pages (id, page, owner, role, tool, value, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(correlation, page.page, scopeFor(env, reqCtx), reqCtx.role, tool, JSON.stringify(page), expiresAt));
  await env.DB.batch(statements);
  const uri = `mcp-st://results/${correlation}/0`;
  const rows = pageValues[0]?.encoding === 'row-page' ? largestTopLevelArray(result) : null;
  const summary = {
    _offloaded: true,
    _result_id: correlation,
    _full: uri,
    _bytes: bytes,
    _pages: pageValues.length,
    _next_cursor: 0,
    _expires_in_seconds: RESULT_TTL_S,
    ...(rows ? { _items_path: rows.path, _total_items: rows.items.length, _preview: preview(rows.items) } : {}),
    ...qualifications(result),
    _recovery: 'Call get_result_page with result_id and cursor. Re-run the original tool if the result expires.',
  };
  return { offloaded: true, content: [{ type: 'text', text: JSON.stringify(summary) }, { type: 'resource_link', uri, name: 'result-page', mimeType: 'application/json' }], structuredContent: summary };
}

interface ResultRow { value: string; tool: string; expires_at: number }

async function ownedResultRow(env: Env, id: string, page: number, reqCtx: RequestContext): Promise<ResultRow | null> {
  return withBudget(env, scopeFor(env, reqCtx), 10_000, scoped => scoped.DB.prepare('SELECT value, tool, expires_at FROM mcp_result_pages WHERE id = ? AND page = ? AND owner = ? AND role = ?')
    .bind(id, page, scopeFor(env, reqCtx), reqCtx.role).first<ResultRow>());
}

export async function getResultPage(env: Env, id: string, page: number, reqCtx: RequestContext): Promise<Record<string, unknown>> {
  if (!reqCtx.principal) throw new McpError('auth_failed', 'Result not found or not authorized');
  if (!Number.isSafeInteger(page) || page < 0) throw new McpError('validation_error', 'cursor must be a non-negative integer');
  const row = await ownedResultRow(env, id, page, reqCtx).catch(() => { throw new McpError('upstream_error', 'Result storage unavailable'); });
  if (!row || (reqCtx.allowedTools && !reqCtx.allowedTools.includes(row.tool))) throw new McpError('validation_error', 'Result not found or not authorized');
  if (row.expires_at <= Date.now()) {
    return { status: 'expired', result_id: id, cursor: page, next_cursor: null, recovery: 'Result expired. Re-run the original tool to create a fresh result.' };
  }
  return { status: 'ok', result_id: id, source_tool: row.tool, ...(JSON.parse(row.value) as StoredPage) };
}

export function registerResultResource(server: McpServer, env: Env, reqCtx?: RequestContext): void {
  const read = async (uri: URL, variables: Record<string, string | string[]>) => {
    if (!reqCtx?.principal) throw new SdkMcpError(ErrorCode.InvalidParams, 'Result not found or not authorized');
    const id = String(variables.id ?? '');
    const page = Number(variables.page ?? 0);
    try {
      const result = await getResultPage(env, id, page, reqCtx);
      if (result.status === 'expired') throw new SdkMcpError(ErrorCode.InvalidParams, String(result.recovery));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof SdkMcpError) throw error;
      const message = error instanceof Error ? error.message : 'Result storage unavailable';
      throw new SdkMcpError(ErrorCode.InvalidParams, message);
    }
  };
  server.registerResource('result-page', new ResourceTemplate('mcp-st://results/{id}/{page}', { list: undefined }), { mimeType: 'application/json' }, read);
  server.registerResource('result', new ResourceTemplate('mcp-st://results/{id}', { list: undefined }), { mimeType: 'application/json' }, read);
}
