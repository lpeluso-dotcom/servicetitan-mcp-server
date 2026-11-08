import { describe, it, expect } from 'vitest';
import { TOOL_PROFILES, PROFILE_FOLLOW_UPS, resolveVisibleTools, profileFor } from '../profiles';
import { TOOLS, toolsForRole } from '../tools';

describe('public task profiles',()=>{
  it('names real tools and never widens roles or grants',()=>{
    const all=new Set(TOOLS.map(t=>t.name));
    for(const [name,tools] of Object.entries(TOOL_PROFILES)) {
      for(const tool of tools)expect(all.has(tool),tool).toBe(true);
      for(const role of ['default','admin','readonly','lockdown'] as const) {
        const permitted=new Set(toolsForRole(role).map(t=>t.name));
        for(const tool of resolveVisibleTools(role,undefined,name))expect(permitted.has(tool.name)).toBe(true);
        expect(resolveVisibleTools(role,[],name).every(t=>PROFILE_FOLLOW_UPS.includes(t.name))).toBe(true);
      }
    }
  });
  it('configuration admin profile cannot promote an operational or readonly identity',()=>{
    expect(resolveVisibleTools('default',undefined,'configuration-admin').every(t=>!t.isWrite)).toBe(true);
    expect(resolveVisibleTools('readonly',undefined,'configuration-admin').every(t=>!t.isWrite)).toBe(true);
    expect(resolveVisibleTools('admin',undefined,'configuration-admin').some(t=>t.name==='update_job_type')).toBe(true);
    expect(resolveVisibleTools('admin',undefined,'configuration-admin').some(t=>t.name==='sell_estimate')).toBe(false);
  });
  it('uses server-authenticated identity and fails closed on malformed profile configuration',()=>{
    const env={TOOL_PROFILES_JSON:JSON.stringify({'oauth:user@example.com':'reporting','mcp-token':'pricebook'})};
    expect(profileFor(env,'oauth:USER@example.com')).toBe('reporting');
    expect(profileFor(env,'mcp-token')).toBe('pricebook');
    expect(profileFor(env,'unmapped')).toBeUndefined();
    expect(profileFor(env,'configuration-admin')).toBe('configuration-admin');
    for(const value of ['[1]','null','{bad','{"mcp-token":"unknown"}','{"MCP-TOKEN":"pricebook","mcp-token":"reporting"}']) expect(()=>profileFor({TOOL_PROFILES_JSON:value},'mcp-token')).toThrow();
    expect(resolveVisibleTools('admin',undefined,'unknown')).toEqual([]);
  });
});
