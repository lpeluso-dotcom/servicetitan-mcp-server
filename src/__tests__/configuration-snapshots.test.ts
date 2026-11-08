import { describe, expect, it, vi } from 'vitest';
import { configurationSnapshotTools } from '../tools/configuration/snapshots';
const ctx={actor:'test',correlation:'snapshot'};
const env={ST_TENANT_ID:'123'} as any;
function fixture() {
 const read=vi.fn(async()=>({data:[{id:1,name:'One'}],has_more:false}));
 const catalog=['job_types','business_units','tag_types'].map(name=>({name:`list_${name}`,handler:read})) as any;
 const [capture,compare]=configurationSnapshotTools(catalog);return {capture,compare,read};
}
describe('configuration export and diff',()=>{
 it('captures all requested sections and compares structural changes without writes',async()=>{
  const f=fixture();const a:any=await f.capture.handler(env,{},ctx);
  expect(a.snapshot.complete).toBe(true);expect(f.read).toHaveBeenCalledTimes(3);
  const b=structuredClone(a.snapshot);b.sections.job_types.records=[{id:1,name:'Renamed'},{id:2,name:'New'}];b.sections.tag_types.records=[];
  const diff:any=await f.compare.handler(env,{before:a.snapshot,after:b},ctx);
  expect(diff.applied).toBe(false);expect(diff.changes.job_types.added[0].id).toBe(2);expect(diff.changes.tag_types.removed[0].id).toBe(1);
  expect(diff.changes.job_types.updated[0].fields.name).toMatchObject({before:'One',after:'Renamed'});
  expect(f.read).toHaveBeenCalledTimes(3);
 });
 it('marks cap-limited sections incomplete and refuses to infer deletions',async()=>{
  const f=fixture();f.read.mockResolvedValue({data:[{id:1,name:'One'}],has_more:true});
  const a:any=await f.capture.handler(env,{sections:['job_types'],maxPages:1},ctx);
  expect(a).toMatchObject({_partial:true,snapshot:{complete:false}});
  await expect(f.compare.handler(env,{before:a.snapshot,after:a.snapshot},ctx)).rejects.toMatchObject({code:'validation_error'});
 });
 it('retains explicit partial state when one section fails',async()=>{
  const f=fixture();f.read.mockRejectedValueOnce(new Error('unavailable'));
  const a:any=await f.capture.handler(env,{},ctx);expect(a.snapshot.sections.job_types.complete).toBe(false);expect(a.snapshot.sections.tag_types.complete).toBe(true);
 });
 it('rejects different tenants, section sets, and duplicate IDs',async()=>{
  const f=fixture();const a:any=(await f.capture.handler(env,{},ctx) as any).snapshot;
  for(const mutate of [(b:any)=>{b.tenant_id='456';},(b:any)=>{delete b.sections.tag_types;},(b:any)=>{b.sections.tag_types.records.push(b.sections.tag_types.records[0]);}]) {
   const b=structuredClone(a);mutate(b);await expect(f.compare.handler(env,{before:a,after:b},ctx)).rejects.toThrow();
  }
 });
 it('distinguishes an absent field from an explicit null',async()=>{
  const f=fixture();const a:any=(await f.capture.handler(env,{sections:['job_types']},ctx) as any).snapshot;const b=structuredClone(a);b.sections.job_types.records[0].summary=null;
  const diff:any=await f.compare.handler(env,{before:a,after:b},ctx);expect(diff.changes.job_types.updated[0].fields.summary).toMatchObject({before_present:false,after_present:true});
 });
});
