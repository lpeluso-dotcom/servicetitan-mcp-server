import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { compactInputSchema, compactToolListOnWire } from '../tool-list-compact';

const MAX = Number.MAX_SAFE_INTEGER;

describe('compactInputSchema', () => {
  it('removes the top-level $schema key only', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { $schema: { type: 'string' } },
    };
    expect(compactInputSchema(input)).toEqual({ type: 'object', properties: { $schema: { type: 'string' } } });
  });

  it('removes safe-integer bounds at any depth, keeps real bounds', () => {
    const input = {
      type: 'object',
      properties: {
        id: { type: 'integer', exclusiveMinimum: 0, maximum: MAX },
        neg: { type: 'integer', minimum: -MAX, maximum: MAX },
        page: { type: 'integer', minimum: 1, maximum: 200 },
        items: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer', maximum: MAX } } } },
        u: { anyOf: [{ type: 'integer', maximum: MAX }, { type: 'null' }] },
      },
    };
    expect(compactInputSchema(input)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer', exclusiveMinimum: 0 },
        neg: { type: 'integer' },
        page: { type: 'integer', minimum: 1, maximum: 200 },
        items: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' } } } },
        u: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    });
  });

  it('keeps a property literally named maximum, descriptions, and additionalProperties', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      properties: { maximum: { type: 'number', description: 'cap' } },
    };
    expect(compactInputSchema(input)).toEqual(input);
  });

  it('does not mutate its input', () => {
    const input = { $schema: 'x', type: 'object', properties: { a: { type: 'integer', maximum: MAX } } };
    const snapshot = JSON.parse(JSON.stringify(input));
    compactInputSchema(input);
    expect(input).toEqual(snapshot);
  });

  it('passes primitives and null through', () => {
    expect(compactInputSchema(null)).toBeNull();
    expect(compactInputSchema(5)).toBe(5);
  });
});

describe('compactToolListOnWire', () => {
  it('returns true and installs the wrap when a real McpServer has a registered tool', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    server.registerTool(
      't',
      { description: 'd', inputSchema: { n: z.number().int() } },
      async () => ({ content: [] })
    );
    expect(compactToolListOnWire(server)).toBe(true);
  });

  it('returns false without throwing when the handler map is missing', () => {
    const fakeServer = { server: {} } as any;
    expect(() => compactToolListOnWire(fakeServer)).not.toThrow();
    expect(compactToolListOnWire(fakeServer)).toBe(false);
  });

  it('returns false when a real McpServer has no tools registered', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(compactToolListOnWire(server)).toBe(false);
  });

  it('returns false when the tools/list entry is not a callable handler', () => {
    const handlers = new Map<string, unknown>([['tools/list', { notAFunction: true }]]);
    const fakeServer = { server: { _requestHandlers: handlers } } as any;
    expect(() => compactToolListOnWire(fakeServer)).not.toThrow();
    expect(compactToolListOnWire(fakeServer)).toBe(false);
    expect(handlers.get('tools/list')).toEqual({ notAFunction: true });
  });

  it('serves the uncompacted list through a real client when the wrap is not installed', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    server.registerTool('t', { description: 'd', inputSchema: { n: z.number().int() } }, async () => ({ content: [] }));
    // No compactToolListOnWire call: this is the state a fail-soft caller is left in.
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['t']);
    } finally {
      await client.close();
    }
  });
});
