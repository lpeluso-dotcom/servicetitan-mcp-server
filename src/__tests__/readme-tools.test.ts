import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PUBLIC_TOOLS } from '../tools/public-registry';

const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
const rows = [...readme.matchAll(/^\| `([a-z0-9_]+)` \| (\w+) \|/gm)].map((m) => ({ name: m[1], kind: m[2] }));

describe('README tool table', () => {
  it('lists exactly PUBLIC_TOOLS', () => {
    expect(rows.map((r) => r.name).sort()).toEqual(PUBLIC_TOOLS.map((t) => t.name).sort());
  });

  it('marks a tool write iff isWrite', () => {
    const wrongKind = PUBLIC_TOOLS.filter((t) => {
      const row = rows.find((r) => r.name === t.name);
      return row?.kind !== (t.isWrite ? 'write' : 'read');
    }).map((t) => t.name);
    expect(wrongKind).toEqual([]);
  });
});
