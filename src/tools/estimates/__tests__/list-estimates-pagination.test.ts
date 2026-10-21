import { beforeEach, it, expect, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('../../../st', () => ({ readST: read }));

import { list_estimates_job as tool } from '../list_estimates_job';

const ctx = { actor: 'test', correlation: 'test' };

beforeEach(() => read.mockReset());

it('preserves all rows and exposes continuation for an intermediate page', async () => {
  const rows = Array.from({ length: 50 }, (_, id) => ({ id }));
  read.mockResolvedValue({ data: rows, hasMore: true, page: 2, totalCount: 125 });
  const result = await tool.handler({} as never, { jobId: 123, page: 2 }, ctx);
  expect(result).toEqual({
    estimates: rows,
    pagination: { page: 2, page_size: 50, has_more: true, total_count: 125, next_page: 3, complete: false },
    _source: 'live',
  });
});

it('marks a terminal page complete only when source explicitly says so', async () => {
  read.mockResolvedValue({ data: [], hasMore: false });
  expect(await tool.handler({} as never, { jobId: 123 }, ctx)).toMatchObject({
    pagination: { complete: true, next_page: null },
  });
  read.mockResolvedValue({ data: [] });
  expect(await tool.handler({} as never, { jobId: 123 }, ctx)).toMatchObject({
    pagination: { complete: false, has_more: null },
  });
});

it('rejects malformed source pages instead of treating them as empty complete results', async () => {
  read.mockResolvedValue({ data: null, hasMore: false });
  await expect(tool.handler({} as never, { jobId: 123 }, ctx)).rejects.toThrow('invalid data page');
});
