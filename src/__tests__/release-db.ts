import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const baseline = migration('0001_core.sql');

/** Real SQLite semantics for D1 claim races, owner predicates and rollback behavior. */
export function releaseDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(baseline);
  const prepare = (sql: string) => {
    let values: Array<string | number | null> = [];
    const statement = {
      bind(...args: Array<string | number | null>) { values = args; return statement; },
      async run() { const r = db.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
      async first() { return db.prepare(sql).get(...values) ?? null; },
      async all() { return { success: true, results: db.prepare(sql).all(...values) }; },
    };
    return statement;
  };
  return { prepare, async batch(statements: Array<ReturnType<typeof prepare>>) {
    db.exec('BEGIN');
    try { const result = await Promise.all(statements.map(s => s.run())); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }, db };
}
