import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { TOOLS, toolsForRole } from '../tools';

const roles=['readonly','default','admin','lockdown'] as const;
const snapshot={schema_version:1,tools:TOOLS.map(tool=>({name:tool.name,write:tool.isWrite,permission:tool.permission,admin_only:tool.adminOnly===true,endpoint:tool.stEndpoint??null,
  roles:roles.filter(role=>toolsForRole(role).some(t=>t.name===tool.name)),
  input:z.toJSONSchema(z.object(tool.zodSchema)),
})).sort((a,b)=>a.name.localeCompare(b.name))};
const path=resolve('contracts/tool-capabilities.json');
if(process.env.UPDATE_CAPABILITIES==='1')writeFileSync(path,JSON.stringify(snapshot,null,2)+'\n');
describe('reviewed capability manifest',()=>{
  it('matches the served catalog, permissions, endpoint and input contract',()=>{
    expect(snapshot).toEqual(JSON.parse(readFileSync(path,'utf8')));
    expect(new Set(snapshot.tools.map(t=>t.name)).size).toBe(snapshot.tools.length);
  });
  it('never exposes admin or business writes to readonly clients',()=>{
    for(const tool of snapshot.tools.filter(t=>t.roles.includes('readonly'))) {
      expect(tool.write).toBe(false);expect(tool.admin_only).toBe(false);expect(tool.permission).toBe('staff');
    }
  });
});
