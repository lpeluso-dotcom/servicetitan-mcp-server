import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { get_form_submission } from '../get_form_submission';
import { PUBLIC_TOOLS, CUT_FROM_RELEASE_1 } from '../../public-registry';
import { McpError } from '../../../errors';

const ctx = { actor: 'test', correlation: 'c1' };

function fakeEnv(respond: (url: string) => { body: unknown; status?: number }) {
  const fetcher = vi.fn(async (url: string) => {
    const { body, status = 200 } = respond(url);
    return new Response(JSON.stringify(body), { status });
  });
  return { ST_TENANT_ID: '000000000', ST_TRANSPORT: { fetch: fetcher }, LEGACY_TEST_KEY: 'k' } as any;
}

function calledUrls(env: any): string[] {
  return (env.ST_TRANSPORT.fetch as any).mock.calls.map((c: unknown[]) =>
    decodeURIComponent(decodeURIComponent(c[0] as string)),
  );
}

describe('get_form_submission schema', () => {
  const schema = z.object(get_form_submission.zodSchema as z.ZodRawShape);

  it('requires both formId and submissionId', () => {
    expect(schema.safeParse({ submissionId: 1 }).success).toBe(false);
    expect(schema.safeParse({ formId: 1 }).success).toBe(false);
    expect(schema.safeParse({ formId: 10, submissionId: 1 }).success).toBe(true);
  });

  it('says the lookup scans one form because ServiceTitan has no per-ID route', () => {
    expect(get_form_submission.description).toMatch(/scans? (one|a single) form/i);
    expect(get_form_submission.description).toMatch(/no per-(id|submission) route/i);
  });
});

describe('get_form_submission handler', () => {
  it('pages the form submissions until it finds the id, and returns live source only', async () => {
    const env = fakeEnv((url) =>
      decodeURIComponent(decodeURIComponent(url)).includes('page=2')
        ? { body: { data: [{ id: 301, formId: 10 }, { id: 302, formId: 10 }], hasMore: false } }
        : { body: { data: [{ id: 101 }, { id: 102 }], hasMore: true } },
    );
    const out = (await get_form_submission.handler(env, { formId: 10, submissionId: 302 }, ctx)) as any;
    expect(out).toEqual({ submission: { id: 302, formId: 10 }, _source: 'live' });
    expect(out).not.toHaveProperty('_freshness');
    const urls = calledUrls(env);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/forms/v2/tenant/000000000/submissions');
    expect(urls[0]).toContain('formIds=10');
    expect(urls[1]).toContain('page=2');
  });

  it('returns a not_found tool error naming both ids when the scan finds nothing', async () => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1 }], hasMore: false } }));
    const err: any = await get_form_submission.handler(env, { formId: 10, submissionId: 999 }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    const res = err.toResponse();
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(err.message).toContain('999');
    expect(err.message).toContain('10');
  });

  it('says the scan was cut short when the page cap is hit without a match', async () => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1 }], hasMore: true } }));
    const err: any = await get_form_submission.handler(env, { formId: 10, submissionId: 999 }, ctx).catch((e: any) => e);
    expect(err.toResponse()).toMatchObject({ code: 'not_found' });
    expect(err.message).toMatch(/page cap|stopped|incomplete|not scanned|cut short/i);
    expect(err.message).toContain('999');
    expect(err.message).toContain('10');
  });

  it('turns an upstream 404 into a clean tool error', async () => {
    const env = fakeEnv(() => ({ body: { title: 'Not Found' }, status: 404 }));
    const err: any = await get_form_submission.handler(env, { formId: 10, submissionId: 1 }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.toResponse()).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('registry', () => {
  it('lists the tool as read-only and removes it from the cut list', () => {
    const t = PUBLIC_TOOLS.find((x) => x.name === 'get_form_submission');
    expect(t).toBeDefined();
    expect(t!.isWrite).toBe(false);
    expect(CUT_FROM_RELEASE_1).not.toHaveProperty('get_form_submission');
  });
});
