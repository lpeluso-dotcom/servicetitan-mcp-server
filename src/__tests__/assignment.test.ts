import { describe, expect, it, vi } from 'vitest';
import { assign_technicians } from '../tools/jobs/assign_technicians';
import { releaseDB } from './release-db';
const ctx={actor:'tester',principal:'staff:test',role:'default' as const,correlation:'assignment-test'};
function fixture() {
  let technicians=[1,2];const events:string[]=[];
  const write=vi.fn(async(body:any)=>{
    if(body.endpoint.endsWith('/assign-technicians')) technicians=[...new Set([...technicians,...body.payload.technicianIds])];
    else technicians=technicians.filter(id=>!body.payload.technicianIds.includes(id));
    return new Response(JSON.stringify({id:42}));
  });
  const transport={fetch:vi.fn(async(url:string,init:RequestInit)=>{
    events.push('fetch');
    if(init?.method==='POST')return write(JSON.parse(String(init.body)));
    expect(new URLSearchParams(new URL(url).searchParams.get('endpoint')!.split('?')[1]).get('appointmentIds')).toBe('42');
    return new Response(JSON.stringify({data:technicians.map(technicianId=>({appointmentId:42,technicianId,active:true})),hasMore:false}));
  })};
  const env:any={DB:releaseDB(),ST_TENANT_ID:'123',CONFIRMATION_SIGNING_KEY:'test-only',MCP_SYNC_KEY:'test',ST_PROXY:transport,ST_TRANSPORT:transport,
    ST_RATE_LIMITER:{idFromName:(name:string)=>name,get:()=>({fetch:async()=>{events.push('gate');return Response.json({allowed:true});}})}};
  return {env,write,events,set:(ids:number[])=>{technicians=ids;}};
}
const args={appointmentId:42,technicianIds:[2,3],dryRun:true};
describe('assignment replacement',()=>{
  it('previews exact differences, adds before removing, and verifies the final set',async()=>{
    const f=fixture();const preview:any=await assign_technicians.handler(f.env,args,ctx);
    expect(f.write).not.toHaveBeenCalled();expect(preview.payload.before).toEqual([1,2]);
    expect(preview.payload.steps.map((s:any)=>s.payload)).toEqual([{jobAppointmentId:42,technicianIds:[3]},{jobAppointmentId:42,technicianIds:[1]}]);
    const result=await assign_technicians.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx);
    expect(result).toMatchObject({verified:true,after:[2,3]});
    expect(f.write.mock.calls.map(([body])=>body.endpoint)).toEqual(['/dispatch/v2/tenant/123/appointment-assignments/assign-technicians','/dispatch/v2/tenant/123/appointment-assignments/unassign-technicians']);
    // Both reads and every mutation pass through the rate guard.
    expect(f.events.every((v,i)=>v!=='fetch'||f.events[i-1]==='gate')).toBe(true);
  });
  it('refuses a stale preview without changing assignments',async()=>{
    const f=fixture();const preview:any=await assign_technicians.handler(f.env,args,ctx);f.set([1,4]);
    await expect(assign_technicians.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).rejects.toThrow(/args changed/);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reports completed steps on second-step failure and does not roll back or retry',async()=>{
    const f=fixture();const preview:any=await assign_technicians.handler(f.env,args,ctx);
    f.write.mockImplementationOnce(async()=>Response.json({id:42})).mockRejectedValueOnce(new Error('lost connection'));
    const result:any=await assign_technicians.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx);
    expect(result).toMatchObject({verified:false,state:'outcome-unknown'});expect(result.completed_steps).toHaveLength(1);expect(f.write).toHaveBeenCalledTimes(2);
  });
  it('stops immediately if the addition fails, preserving existing technicians',async()=>{
    const f=fixture();const preview:any=await assign_technicians.handler(f.env,args,ctx);f.write.mockRejectedValueOnce(new Error('rejected'));
    expect(await assign_technicians.handler(f.env,{...args,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).toMatchObject({verified:false,completed_steps:[]});
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('performs no mutation when the requested set already matches',async()=>{
    const f=fixture();const same={...args,technicianIds:[1,2]};const preview:any=await assign_technicians.handler(f.env,same,ctx);
    expect(await assign_technicians.handler(f.env,{...same,dryRun:false,confirmation_token:preview.confirmation_token},ctx)).toMatchObject({verified:true,completed_steps:[]});
    expect(f.write).not.toHaveBeenCalled();
  });
});
