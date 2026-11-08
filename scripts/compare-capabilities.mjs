// Compare two reviewed manifests without credentials or live tenant access.
// node scripts/compare-capabilities.mjs path/to/first.json path/to/second.json
import { readFileSync } from 'node:fs';
const [firstPath, secondPath] = process.argv.slice(2);
if (!firstPath || !secondPath) throw new Error('Pass two tool-capabilities.json files');
const first = new Map(JSON.parse(readFileSync(firstPath, 'utf8')).tools.map(t => [t.name,t]));
const second = new Map(JSON.parse(readFileSync(secondPath, 'utf8')).tools.map(t => [t.name,t]));
const changed = [...first].filter(([name,tool]) => second.has(name) && JSON.stringify(tool) !== JSON.stringify(second.get(name))).map(([name]) => name);
console.log(JSON.stringify({ first_count:first.size, second_count:second.size, first_only:[...first.keys()].filter(n => !second.has(n)), second_only:[...second.keys()].filter(n => !first.has(n)), changed_shared_contracts:changed },null,2));
