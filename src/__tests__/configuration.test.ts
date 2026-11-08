import { describe, expect, it, vi } from 'vitest';
import { CONFIGURATION_TOOLS } from '../tools/configuration';
import { releaseDB } from './release-db';
import { z } from 'zod';

const ctx = { actor: 'config-test', principal: 'admin:test', role: 'admin' as const, correlation: 'configuration-test' };
const tool = (name: string) => CONFIGURATION_TOOLS.find(t => t.name === name)!;
const guid = 'f725260a-3e9d-4012-9964-3023d16a618d';
function fixture() {
  let current: Record<string, unknown> = { id: 42, name: 'Original', active: true };
  const write = vi.fn(async (body: any) => { current = { ...current, ...body.payload }; return new Response(JSON.stringify(current)); });
  const read = vi.fn(async () => new Response(JSON.stringify(current)));
  const transport = { fetch: vi.fn(async (_url: string, init: RequestInit) => init?.method === 'POST' ? write(JSON.parse(String(init.body))) : read()) };
  const env: any = { DB: releaseDB(), ST_TENANT_ID: '123', ST_TRANSPORT: transport, ST_PROXY: transport, MCP_SYNC_KEY: 'test', CONFIRMATION_SIGNING_KEY: 'unit-test-only', CONFIGURATION_WRITES_ENABLED: 'true' };
  return { env, write, read, set: (value: Record<string, unknown>) => { current = value; } };
}

describe('configuration contract and write lifecycle', () => {
  it('requires admin and the independent enable switch before preview or network access', async () => {
    const f = fixture(); const args = { id:42, changes:{ name:'New' } };
    await expect(tool('update_job_type').handler(f.env,args,{...ctx,role:'default'})).rejects.toMatchObject({code:'auth_failed'});
    delete f.env.CONFIGURATION_WRITES_ENABLED;
    await expect(tool('update_job_type').handler(f.env,args,ctx)).rejects.toMatchObject({code:'config_error'});
    expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  });
  it('previews without mutation, writes exact changes, and verifies read-back', async () => {
    const f=fixture(); const args={id:42,changes:{name:'New'}}; const t=tool('update_job_type');
    const preview:any=await t.handler(f.env,args,ctx);
    expect(preview).toMatchObject({dryRun:true,current:{name:'Original'},proposed:{name:'New'},st_method:'PATCH'});
    expect(f.write).not.toHaveBeenCalled();
    const result:any=await t.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx);
    expect(f.write).toHaveBeenCalledExactlyOnceWith({endpoint:'/jpm/v2/tenant/123/job-types/42',method:'PATCH',payload:{name:'New'}});
    expect(result).toMatchObject({state:'verified',verified:true,mismatched_fields:[]});
  });
  it('rejects records changed since preview without writing', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    const preview:any=await t.handler(f.env,args,ctx);f.set({id:42,name:'Concurrent edit',active:true});
    await expect(t.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).rejects.toThrow(/args changed/);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('binds preview to the authenticated principal even when actors match', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    const preview:any=await t.handler(f.env,args,ctx);
    await expect(t.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},{...ctx,principal:'admin:other'})).rejects.toThrow(/args changed/);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('consumes a token once even when upstream fails; never retries a write', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    f.write.mockRejectedValue(new Error('connection lost'));
    const preview:any=await t.handler(f.env,args,ctx); const confirmed={...args,dryRun:false,confirmation_token:preview.confirmation_token};
    expect(await t.handler(f.env,confirmed,ctx)).toMatchObject({state:'outcome-unknown',verified:false});
    await expect(t.handler(f.env,confirmed,ctx)).rejects.toThrow(/already used/);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('does not label a silently ignored field as verified', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    f.write.mockImplementation(async()=>new Response(JSON.stringify({id:42})));
    const preview:any=await t.handler(f.env,args,ctx);
    expect(await t.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).toMatchObject({verified:false,state:'outcome-unknown',mismatched_fields:['name']});
  });
  it('honors READONLY at confirmation time', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    const preview:any=await t.handler(f.env,args,ctx);f.env.READONLY='1';
    await expect(t.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).rejects.toThrow(/read.only/i);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rejects unsupported business-unit settings, unknown job-type fields, and empty changes', async () => {
    const f=fixture();
    for(const [name,changes] of [['update_business_unit_metadata',{name:'New'}],['update_job_type',{active:false}],['update_job_type',{}]] as const) {
      await expect(tool(name).handler(f.env,{id:42,changes},ctx)).rejects.toThrow();
    }
    expect(f.read).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
  });
  it('validates tag color against the pinned contract', () => {
    const schema=z.object(tool('create_tag_type').zodSchema);
    expect(schema.safeParse({changes:{name:'Test',color:'red'}}).success).toBe(false);
    expect(schema.safeParse({changes:{name:'Test',color:'#123ABC'}}).success).toBe(true);
  });
  it('shows metadata merge and deletion effects before execution', async () => {
    const f=fixture();f.set({id:42,externalData:[{key:'retained',value:'yes'},{key:'deleted',value:'old'}]});
    const result:any=await tool('update_business_unit_metadata').handler(f.env,{id:42,changes:{externalData:{applicationGuid:guid,patchMode:'Merge',externalData:[{key:'deleted',value:null},{key:'added',value:'new'}]}}},ctx);
    expect(result.proposed.externalData).toEqual([{key:'added',value:'new'},{key:'retained',value:'yes'}]);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rejects malformed pagination instead of reporting an empty complete list', async () => {
    const f=fixture();f.read.mockImplementation(async()=>new Response(JSON.stringify({data:[]})));
    await expect(tool('list_job_types').handler(f.env,{},ctx)).rejects.toMatchObject({code:'upstream_error'});
  });
  it('fails tag lookup at its bounded scan cap', async () => {
    const f=fixture();f.read.mockImplementation(async()=>new Response(JSON.stringify({data:[{id:1}],hasMore:true})));
    await expect(tool('get_tag_type').handler(f.env,{id:42},ctx)).rejects.toThrow(/scan limit/);
    expect(f.read).toHaveBeenCalledTimes(20);
  });
  it('verifies created job types and tag types using the returned identity', async () => {
    for(const name of ['create_job_type','create_tag_type']) {
      const f=fixture();const t=tool(name);const changes=name==='create_tag_type'?{name:'Created',color:'#123ABC'}:{name:'Created'};
      if(name==='create_tag_type')f.read.mockImplementation(async()=>Response.json({data:[{id:42,...changes}],hasMore:false}));
      const preview:any=await t.handler(f.env,{changes},ctx);
      expect(preview.current).toBeNull();expect(f.read).not.toHaveBeenCalled();
      expect(await t.handler(f.env,{changes,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).toMatchObject({verified:true});
    }
  });
  it('verifies metadata merge, retention and deletion against the read-back array', async () => {
    const f=fixture();f.set({id:42,externalData:[{key:'kept',value:'yes'},{key:'removed',value:'old'}]});
    const changes={externalData:{applicationGuid:guid,patchMode:'Merge',externalData:[{key:'removed',value:null},{key:'added',value:'new'}]}};
    f.write.mockImplementation(async()=>{f.set({id:42,externalData:[{key:'kept',value:'yes'},{key:'added',value:'new'}]});return Response.json({id:42});});
    const t=tool('update_business_unit_metadata');const preview:any=await t.handler(f.env,{id:42,changes},ctx);
    expect(await t.handler(f.env,{id:42,changes,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).toMatchObject({verified:true});
  });
  it('refuses unsupported tag metadata query parameters', async () => {
    const f=fixture();await expect(tool('get_tag_type').handler(f.env,{id:42,externalDataApplicationGuid:guid},ctx)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('holds the shared object lease across read, mutation and read-back', async () => {
    const f=fixture();const t=tool('update_job_type');const args={id:42,changes:{name:'New'}};
    const a:any=await t.handler(f.env,args,ctx);const b:any=await t.handler(f.env,args,ctx);
    let unblock!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(r=>{started=r;});const blocked=new Promise<void>(r=>{unblock=r;});
    f.write.mockImplementationOnce(async()=>{started();await blocked;f.set({id:42,name:'New',active:true});return Response.json({id:42});});
    const first=t.handler(f.env,{...args,dryRun:false,confirmation_token:a.confirmation_token},ctx);await entered;
    const reads=f.read.mock.calls.length;
    await expect(t.handler(f.env,{...args,dryRun:false,confirmation_token:b.confirmation_token},ctx)).rejects.toMatchObject({code:'rate_limited'});
    expect(f.read).toHaveBeenCalledTimes(reads);unblock();expect(await first).toMatchObject({verified:true});
    await expect(t.handler(f.env,{...args,dryRun:false,confirmation_token:b.confirmation_token},ctx)).rejects.toThrow(/args changed/);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized upstream pages before a snapshot can claim completeness', async () => {
    const f=fixture();f.read.mockImplementation(async()=>Response.json({data:[{id:1},{id:2}],hasMore:false}));
    await expect(tool('list_job_types').handler(f.env,{pageSize:1},ctx)).rejects.toThrow(/requested size/);
  });

});
