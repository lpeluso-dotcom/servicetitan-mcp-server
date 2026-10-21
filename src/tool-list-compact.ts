import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function compactInputSchema<T>(schema: T): T {
  return strip(schema, true) as T;
}

function strip(node: unknown, isRoot: boolean): unknown {
  if (Array.isArray(node)) return node.map((child) => strip(child, false));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isRoot && key === '$schema') continue;
    if (key === 'maximum' && value === MAX_SAFE) continue;
    if (key === 'minimum' && value === -MAX_SAFE) continue;
    out[key] = strip(value, false);
  }
  return out;
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Wrap the SDK's tools/list handler so every inputSchema is compacted on the wire.
 * The SDK has no public hook for this, so this reaches into its private handler
 * map. It fails soft: if an SDK upgrade renames or restructures those internals,
 * it returns false instead of throwing, and the caller serves the uncompacted
 * (still correct) tool list rather than failing every request. Call AFTER tools
 * are registered.
 *
 * @returns true if the wrap was installed, false if it could not be.
 */
export function compactToolListOnWire(server: McpServer): boolean {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  if (!(handlers instanceof Map)) return false;
  const original = handlers.get('tools/list');
  if (typeof original !== 'function') return false;
  handlers.set('tools/list', async (request, extra) => {
    const result = (await original(request, extra)) as { tools?: Array<Record<string, unknown>> };
    return {
      ...result,
      tools: (result.tools ?? []).map((tool) => ({ ...tool, inputSchema: compactInputSchema(tool.inputSchema) })),
    };
  });
  return true;
}
