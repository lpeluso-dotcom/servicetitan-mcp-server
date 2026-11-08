import { describe,it,expect,vi } from 'vitest';
import { releaseDB } from './release-db';
import { withBudget } from '../request-budget';
import { WriteGate } from '../write-gate';
import { scopeFor } from '../scope';
import { operationStatus,recoverableWrite } from '../operations';
import { withWriteLease } from '../write-lease';
const ctx={actor:'same-actor',principal:'alice',role:'admin' as const};
function fixture():any {return {DB:releaseDB(),ST_TENANT_ID:'123',CONFIRMATION_SIGNING_KEY:'fixture-only-key',MCP_SYNC_KEY:'fixture-only-key',ST_TRANSPORT:{fetch:vi.fn()},ST_PROXY:{fetch:vi.fn()}};}
describe('adversarial ownership, replay and concurrency',()=>{
 it('denies token replay across tenant, principal and role even with the same actor',async()=>{
  const env=fixture();const token=await withBudget(env,scopeFor(env,ctx),1000,e=>new WriteGate(e).dryRun('fixture',{},ctx.actor,'c',{},'/test','PATCH'));
  for(const [tenant,principal,role] of [['456','alice','admin'],['123','bob','admin'],['123','alice','default']] as const) {
   const other={...env,ST_TENANT_ID:tenant};await expect(withBudget(other,scopeFor(other,{...ctx,principal,role}),1000,e=>new WriteGate(e).verifyToken('fixture',{},ctx.actor,token.confirmation_token))).rejects.toThrow(/identity mismatch/);
  }
 });
 it('rejects unowned legacy tokens even when a principal embeds the legacy identity name',async()=>{
  const env=fixture();const token=await new WriteGate(env).dryRun('fixture',{},ctx.actor,'c',{},'/test','PATCH');
  for(const principal of ['legacy-shared-client','jwt:legacy-shared-client-attacker']) await expect(withBudget(env,scopeFor(env,{...ctx,principal}),1000,e=>new WriteGate(e).verifyToken('fixture',{},ctx.actor,token.confirmation_token))).rejects.toThrow(/identity mismatch/);
 });
 it('allows only one concurrent token consumer',async()=>{
  const env=fixture();const token=await new WriteGate(env).dryRun('fixture',{},ctx.actor,'c',{},'/test','PATCH');
  const results=await Promise.allSettled([1,2].map(()=>new WriteGate(env).verifyToken('fixture',{},ctx.actor,token.confirmation_token)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 });
 it('blocks operation retrieval after the original tool is removed from the profile',async()=>{
  const env=fixture();const owner=scopeFor(env,ctx);const result:any=await recoverableWrite(env,'update_job_type',{confirmation_token:'fixture'},owner,'admin',async()=>({verified:true}));
  await expect(operationStatus(env,result.operation_id,owner,'admin',undefined,['st_operation_status'])).rejects.toMatchObject({code:'not_found'});
  expect(await operationStatus(env,result.operation_id,owner,'admin',undefined,['update_job_type','st_operation_status'])).toMatchObject({state:'verified'});
 });
 it('deduplicates an ambiguous write response without resubmitting',async()=>{
  const env=fixture();const owner=scopeFor(env,ctx);const invoke=vi.fn(async()=>({verified:false}));
  const results=await Promise.all([1,2].map(()=>recoverableWrite(env,'fixture',{confirmation_token:'fixture'},owner,'admin',invoke)));
  expect(invoke).toHaveBeenCalledTimes(1);expect((results[0] as any).operation_id).toBe((results[1] as any).operation_id);
 });
 it('serializes same-object writes across identities and releases the lock after a failure',async()=>{
  const env=fixture();let release!:()=>void;let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});const held=new Promise<void>(r=>{release=r;});
  const first=withWriteLease(env,'object:123:42',async()=>{started();await held;return 1;});await entered;
  await expect(withWriteLease(env,'object:123:42',async()=>2)).rejects.toMatchObject({code:'rate_limited'});
  expect(await withWriteLease(env,'object:123:43',async()=>3)).toBe(3);release();expect(await first).toBe(1);
  await expect(withWriteLease(env,'object:123:42',async()=>{throw new Error('failed');})).rejects.toThrow('failed');
  expect(await withWriteLease(env,'object:123:42',async()=>4)).toBe(4);
 });
});
