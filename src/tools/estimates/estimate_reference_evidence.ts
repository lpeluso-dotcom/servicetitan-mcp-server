import {z} from 'zod';
import {readST} from '../../st';
import type {ToolDef} from '../index';

const fields=['customerId','jobId','locationId','projectId'] as const;
interface Args {estimateIds:number[]}
const argsSchema=z.object({estimateIds:z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(20).refine(ids=>new Set(ids).size===ids.length,'Estimate IDs must be unique')});
type SourceRecord=Record<string,unknown>;
function record(value:unknown):SourceRecord {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Estimate source response is not a record.');
 return value as SourceRecord;
}
function references(value:SourceRecord){
 const present=fields.filter(f=>Object.hasOwn(value,f));
 return {id:value.id,fields:Object.fromEntries(present.map(f=>[f,value[f]])),missing_fields:fields.filter(f=>!present.includes(f)),modifiedOn:value.modifiedOn??null};
}

/** Same staff/read-only permission as get_estimate; fixed GET routes only. */
export const estimate_reference_evidence:ToolDef<Args>={
 name:'estimate_reference_evidence',isWrite:false,permission:'staff',
 description:'Source: live ST. Compare current ServiceTitan listing and detail reference IDs for 1–20 exact estimate IDs. Returns only customer/job/location/project references, modification timestamps, pagination completeness and differences. Missing fields, missing records, duplicate results or ignored filters are not proof that either representation is authoritative. No repair or identity approval is performed.',
 zodSchema:argsSchema.shape,
 stEndpoint:{method:'GET',path:'/sales/v2/tenant/{tid}/estimates',source:'live'},
 async handler(env,args,ctx){
  // Validate here as well as at MCP registration for other internal callers.
  const {estimateIds}=argsSchema.parse(args);
  const wanted=new Set(estimateIds);const listed=new Map<number,SourceRecord>();
  const startedAt=new Date().toISOString();let pages=0;let complete=false;let total:number|null=null;
  for(let page=1;page<=5;page++){
   const response=record(await readST<unknown>(env,ctx,'/sales/v2/tenant/000000000/estimates',{
    ids:estimateIds.join(','),active:'Any',page,pageSize:200,includeTotal:true,
   }));
   if(!Array.isArray(response.data)||typeof response.hasMore!=='boolean')throw new Error('Estimate listing pagination is incomplete or malformed.');
   if(response.page!==undefined&&response.page!==page)throw new Error('Estimate listing returned an unexpected page.');
   if(response.totalCount!==undefined){
    if(!Number.isSafeInteger(response.totalCount)||Number(response.totalCount)<0)throw new Error('Estimate listing total is malformed.');
    if(total!==null&&total!==response.totalCount)throw new Error('Estimate listing changed during pagination.');
    total=Number(response.totalCount);
   }
   for(const value of response.data){
    const row=record(value);const id=row.id;
    if(typeof id!=='number'||!wanted.has(id))throw new Error('Estimate listing did not preserve the exact ID filter.');
    if(listed.has(id))throw new Error('Estimate listing returned duplicate IDs; evidence is ambiguous.');
    listed.set(id,row);
   }
   pages++;
   if(!response.hasMore){complete=true;break;}
  }
  if(!complete)throw new Error('Estimate listing reached the pagination cap; comparison is incomplete.');
  if(total!==null&&total!==listed.size)throw new Error('Estimate listing total does not match the completed pages.');
  const listingObservedAt=new Date().toISOString();const comparisons=[];
  for(const id of estimateIds){
   const detail=record(await readST<unknown>(env,ctx,`/sales/v2/tenant/000000000/estimates/${id}`));
   if(detail.id!==id)throw new Error('Estimate detail returned a different ID.');
   const source=listed.get(id);const detailRefs=references(detail);const listRefs=source?references(source):null;
   const missing=fields.filter(f=>!Object.hasOwn(detail,f)||!source||!Object.hasOwn(source,f));
   const differences=source?fields.filter(f=>Object.hasOwn(detail,f)&&Object.hasOwn(source,f)&&JSON.stringify(detail[f])!==JSON.stringify(source[f])):[];
   comparisons.push({estimate_id:id,listing:listRefs,detail:detailRefs,detail_observed_at:new Date().toISOString(),reference_differences:differences,
    comparison:!source?'absent_from_complete_listing':missing.length?'reference_fields_unavailable':differences.length?'source_representations_differ':'references_agree'});
  }
  return {_source:'live_servicetitan_listing_and_detail',started_at:startedAt,listing_observed_at:listingObservedAt,completed_at:new Date().toISOString(),
   listing_complete:true,pages_fetched:pages,listing_rows:listed.size,total_count:total,comparisons,source_reads_atomic:false,
   identity_changes_authorized:false};
 },
};
