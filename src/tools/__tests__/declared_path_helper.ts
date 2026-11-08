// Shared test helper: assert the ST path a tool actually called matches the
// method + path it declares in `stEndpoint` (the same pair contracts.test.ts
// checks against the OpenAPI snapshot). Catches a handler that drifts from its
// declaration.
//
// Tenant normalisation relies on the test env's `ST_TENANT_ID: '000000000'`:
// readST sends the path with that placeholder tenant, and it matches the
// `{tid}`-normalised declared path. A test env with a real tenant ID would
// compare as a different operation.
import { expect } from 'vitest';
import { opKey } from '../../../contracts/normalize';
import type { ToolDef } from '../index';

/** ST path the proxy was asked for. readST sends it URL-encoded in the `endpoint` query param. */
function extractStPath(calledUrl: string): string {
  const q = calledUrl.indexOf('?');
  const search = q >= 0 ? new URLSearchParams(calledUrl.slice(q + 1).replace(/#.*$/, '')) : null;
  const endpoint = search?.get('endpoint');
  const raw = endpoint ?? calledUrl;
  // strip scheme/host, then any query string
  return raw.replace(/^https?:\/\/[^/?#]+/i, '').replace(/[?#].*$/, '');
}

/** Turn numeric segments that sit under a `{param}` slot of the template into that slot. */
function bindIds(calledPath: string, template: string): string {
  const t = template.replace(/^https?:\/\/[^/?#]+/i, '').split('/');
  return calledPath
    .split('/')
    .map((seg, i) => (/^\d+$/.test(seg) && /^\{[^}]*\}$/.test(t[i] ?? '') ? t[i] : seg))
    .join('/');
}

/**
 * `methodOrInit` is the fetch `init` of the recorded call (e.g.
 * `env.ST_TRANSPORT.fetch.mock.calls[0][1]`); the method is `init?.method ?? 'GET'`.
 * A bare method string is also accepted.
 */
export function expectCalledPathMatchesDeclared(
  tool: Pick<ToolDef<any>, 'name' | 'stEndpoint'>,
  calledUrl: string,
  methodOrInit?: string | { method?: string } | null,
): void {
  const calledMethod = typeof methodOrInit === 'string' ? methodOrInit : (methodOrInit?.method ?? 'GET');
  const declared = tool.stEndpoint;
  expect(declared, `${tool.name} declares no stEndpoint`).toBeDefined();
  const called = bindIds(extractStPath(calledUrl), declared!.path);
  expect(opKey(calledMethod, called), `${tool.name} called a different ST operation than it declares`)
    .toBe(opKey(declared!.method, declared!.path));
}
