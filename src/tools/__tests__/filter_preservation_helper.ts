import { expect, vi } from 'vitest';
import type { ToolDef } from '../index';

export type FilterExpect =
  | 'forwarded_query'
  | 'forwarded_path'
  | 'rejected_or_skipped';

export interface FilterSpec {
  value: unknown;
  expect: FilterExpect;
  
  key?: string;
  
  column?: string;
}

export type FilterMatrix = Record<string, FilterSpec>;

export interface HarnessEnvOverrides {
  ST_TENANT_ID?: string;
  liveResponse?: unknown;
  d1Response?: unknown;
  liveStatus?: number;
  d1Status?: number;
}

interface CapturedCall {
  url: string;
  body: { sql?: string; params?: unknown[] } | null;
}

function makeHarnessEnv(
  capture: CapturedCall[],
  overrides: HarnessEnvOverrides = {},
): unknown {
  const liveResponse = overrides.liveResponse ?? { data: [] };
  const d1Response = overrides.d1Response ?? { success: true, results: [] };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const bodyText = init?.body ? String(init.body) : '';
    let parsedBody: CapturedCall['body'] = null;
    if (bodyText && bodyText.startsWith('{')) {
      try { parsedBody = JSON.parse(bodyText); } catch {  }
    }
    capture.push({ url: u, body: parsedBody });
    if (u.includes('/api/legacy-sql-read')) {
      return new Response(JSON.stringify(d1Response), { status: overrides.d1Status ?? 200 });
    }
    if (u.includes('/api/st/read')) {
      return new Response(JSON.stringify(liveResponse), { status: overrides.liveStatus ?? 200 });
    }
    return new Response('{}', { status: 200 });
  });
  return {
    ST_TENANT_ID: overrides.ST_TENANT_ID ?? '000000000',
    ST_TRANSPORT: { fetch: fetcher },
    LEGACY_TEST_KEY: 'test',
  };
}

export async function assertFilterPreservation<Args extends Record<string, unknown>>(
  tool: ToolDef<Args>,
  matrix: FilterMatrix,
  baseArgs: Partial<Args> = {},
  overrides: HarnessEnvOverrides = {},
): Promise<Record<string, CapturedCall[]>> {
  const perFilter: Record<string, CapturedCall[]> = {};

  for (const [field, spec] of Object.entries(matrix)) {
    const capture: CapturedCall[] = [];
    const env = makeHarnessEnv(capture, overrides);
    const args = { ...baseArgs, [field]: spec.value } as unknown as Args;

    let threw = false;
    let thrownMessage = '';
    let result: unknown = null;
    try {
      result = await tool.handler(env as never, args, { actor: 'test', correlation: `flt-${field}` });
    } catch (err) {
      threw = true;
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    const calls = capture;
    perFilter[field] = calls;

    if (spec.expect === 'rejected_or_skipped') {
      if (threw) {
        expect(thrownMessage, `tool ${tool.name} threw on ${field} but message must reference the field`).toMatch(
          new RegExp(field),
        );
        continue;
      }
      
      const r = result as { _fallback_skipped?: string } | null;
      expect(r?._fallback_skipped, `tool ${tool.name} silently accepted ${field} without rejecting OR skipping`).toBeTruthy();
      expect(r?._fallback_skipped, `tool ${tool.name} _fallback_skipped must reference ${field}`).toContain(field);
      continue;
    }

    expect(threw, `tool ${tool.name} unexpectedly threw on ${field}: ${thrownMessage}`).toBe(false);

    if (spec.expect === 'forwarded_query') {
      const key = spec.key ?? field;
      const liveCalls = calls.filter((c) => c.url.includes('/api/st/read'));
      expect(liveCalls.length, `tool ${tool.name} did not hit live ST for ${field}`).toBeGreaterThan(0);
      const matched = liveCalls.some((c) => {
        
        
        return c.url.includes(`${key}=`) || c.url.includes(`${key}%3D`);
      });
      expect(matched, `tool ${tool.name} did not forward ${field} (key=${key}) to live ST. URLs: ${liveCalls.map((c) => c.url).join('\n')}`).toBe(true);
    } else if (spec.expect === 'forwarded_path') {
      const liveCalls = calls.filter((c) => c.url.includes('/api/st/read'));
      const valStr = String(spec.value);
      const encoded = encodeURIComponent(valStr);
      const matched = liveCalls.some((c) => c.url.includes(valStr) || c.url.includes(encoded));
      expect(matched, `tool ${tool.name} did not place ${field}=${valStr} into the ST path`).toBe(true);
    }
  }

  return perFilter;
}
