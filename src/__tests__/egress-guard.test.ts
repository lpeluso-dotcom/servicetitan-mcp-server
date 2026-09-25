import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { findEgressViolations, listSourceFiles, scanSourceForEgress } from './guards/egress-scan';

describe('egress guard', () => {
  it('no file outside src/backend references the ServiceTitan API/auth host', () => {
    const violations = findEgressViolations(process.cwd());
    expect(violations.map((v) => `${v.file}:${v.line} ${v.rule}`)).toEqual([]);
  });

  it('flags a planted violation and ignores comments and the backend', () => {
    const source = [
      "await fetch('https://api.servicetitan.io/crm/v2/tenant/1/customers');",
      '// api.servicetitan.io named in a comment is fine',
      "await fetch('https://auth.servicetitan.io/connect/token');",
    ].join('\n');
    expect(scanSourceForEgress('src/tools/planted.ts', source).map((v) => `${v.line} ${v.rule}`)).toEqual([
      '1 st-host',
      '3 st-host',
    ]);
    expect(scanSourceForEgress('src/backend/direct.ts', source)).toEqual([]);
  });

  it('flags code that follows an inline block comment on the same line', () => {
    const source = "/* eslint-disable-next-line */ await fetch('https://api.servicetitan.io/x');";
    expect(scanSourceForEgress('src/tools/planted-inline-block.ts', source).map((v) => `${v.line} ${v.rule}`)).toEqual([
      '1 st-host',
    ]);
  });

  it('does not flag a ServiceTitan host mentioned inside a multi-line block comment', () => {
    const source = ['/*', ' * see api.servicetitan.io for docs', ' */'].join('\n');
    expect(scanSourceForEgress('src/tools/planted-block-comment.ts', source)).toEqual([]);
  });

  it('lists a planted .mjs file under src', () => {
    const root = mkdtempSync(join(tmpdir(), 'egress-scan-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'planted.mjs'), "await fetch('https://api.servicetitan.io/x');\n");
    expect(listSourceFiles(root)).toEqual([join(root, 'src', 'planted.mjs')]);
  });
});
