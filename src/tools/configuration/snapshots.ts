import { z } from 'zod';
import { McpError } from '../../errors';
import type { ToolDef } from '../index';

const sectionNames=['job_types','business_units','tag_types'] as const;
const row=z.object({id:z.number().int().positive().safe()}).catchall(z.unknown());
const section=z.object({complete:z.boolean(),records:z.array(row).max(1000),pages:z.number().int().nonnegative(),error:z.string().optional()}).strict();
const snapshot=z.object({schema_version:z.literal(1),tenant_id:z.string().regex(/^\d+$/),captured_at:z.string(),complete:z.boolean(),sections:z.unknown()});
// A snapshot may include any nonempty subset of the three supported sections.
const snapshotSchema=snapshot.extend({sections:z.object({job_types:section.optional(),business_units:section.optional(),tag_types:section.optional()}).strict()}).strict();
type Snapshot=z.infer<typeof snapshotSchema>;

function same(a:unknown,b:unknown):boolean {
  if(Object.is(a,b))return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
  const left=a as Record<string,unknown>;const right=b as Record<string,unknown>;
  return Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>Object.hasOwn(right,key)&&same(left[key],right[key]));
}

export function configurationSnapshotTools(catalog:readonly ToolDef<any>[]):ToolDef<any>[] {
  const input=z.object({sections:z.array(z.enum(sectionNames)).min(1).max(3).refine(v=>new Set(v).size===v.length,'Sections must be unique').default([...sectionNames]),pageSize:z.number().int().positive().max(200).default(200),maxPages:z.number().int().positive().max(5).default(5)}).strict();
  return [{
    name:'configuration_snapshot',permission:'staff',isWrite:false,
    description:'Capture live job types, business units and tag types for review or export. Source: live ST. Default page size 200, max 200, up to 5 pages per section. Marks failed or capped sections incomplete. Reads are sequential and not atomic. Store the snapshot object to compare later; this tool never restores or changes configuration.',
    zodSchema:input.shape,stEndpoint:{method:'GET',path:'/jpm/v2/tenant/{tid}/job-types',variants:['/jpm/v2/tenant/{tid}/job-types','/settings/v2/tenant/{tid}/business-units','/settings/v2/tenant/{tid}/tag-types'],source:'live'},
    async handler(env,args,ctx) {
      const parsed=input.parse(args);
      if(!env.ST_TENANT_ID||!/^\d+$/.test(env.ST_TENANT_ID))throw new McpError('config_error','ST_TENANT_ID is required');
      const result:Snapshot={schema_version:1,tenant_id:env.ST_TENANT_ID,captured_at:new Date().toISOString(),complete:true,sections:{}};
      for(const name of parsed.sections) {
        const state:{complete:boolean;records:z.infer<typeof row>[];pages:number;error?:string}={complete:false,records:[],pages:0};result.sections[name]=state;
        const read=catalog.find(t=>t.name===`list_${name}`)!;const ids=new Set<number>();
        try {
          for(let page=1;page<=parsed.maxPages;page++) {
            const response=await read.handler(env,{page,pageSize:parsed.pageSize,active:'Any'},ctx) as {data:unknown[];has_more:boolean};
            for(const value of response.data) {const record=row.parse(value);if(ids.has(record.id))throw new Error('duplicate ID');ids.add(record.id);state.records.push(record);}
            state.pages++;
            if(!response.has_more){state.complete=true;break;}
          }
          if(!state.complete)state.error='Page limit reached; snapshot is incomplete';
        } catch {state.error='Section could not be read consistently; snapshot is incomplete';}
        if(!state.complete)result.complete=false;
      }
      return {snapshot:result,source_reads_atomic:false,_source:'live',_partial:!result.complete};
    },
  },{
    name:'compare_configuration_snapshots',permission:'staff',isWrite:false,
    description:'Compare two complete configuration_snapshot objects from the same tenant and matching sections. Source: computed from supplied snapshots, no live API request. Returns added/removed IDs and structural field changes; array order counts as a change. Rejects incomplete snapshots. This is review evidence, not authorization to apply changes.',
    zodSchema:{before:snapshotSchema,after:snapshotSchema},stEndpoint:{method:'GET',path:'local:configuration-diff',source:'computed'},
    async handler(_env,args) {
      const {before,after}=z.object({before:snapshotSchema,after:snapshotSchema}).strict().parse(args);
      const names=Object.keys(before.sections).sort() as Array<typeof sectionNames[number]>;
      if(!before.complete||!after.complete||before.tenant_id!==after.tenant_id||names.length===0||JSON.stringify(names)!==JSON.stringify(Object.keys(after.sections).sort()))throw new McpError('validation_error','Snapshots must be complete, from the same tenant, and contain matching sections');
      const changes:Record<string,unknown>={};
      for(const name of names) {
        const a=before.sections[name]!;const b=after.sections[name]!;
        if(!a.complete||!b.complete)throw new McpError('validation_error','Cannot compare an incomplete section');
        const old=new Map(a.records.map(v=>[v.id,v]));const next=new Map(b.records.map(v=>[v.id,v]));
        if(old.size!==a.records.length||next.size!==b.records.length)throw new McpError('validation_error','Snapshot contains duplicate IDs');
        const updated=[];
        for(const [id,current] of next) {
          const prior=old.get(id);if(!prior)continue;
          const fields:Record<string,unknown>={};
          for(const key of new Set([...Object.keys(prior),...Object.keys(current)])) {
            if(Object.hasOwn(prior,key)!==Object.hasOwn(current,key)||!same(prior[key],current[key]))fields[key]={before_present:Object.hasOwn(prior,key),after_present:Object.hasOwn(current,key),before:prior[key]??null,after:current[key]??null};
          }
          if(Object.keys(fields).length)updated.push({id,fields});
        }
        changes[name]={added:b.records.filter(v=>!old.has(v.id)),removed:a.records.filter(v=>!next.has(v.id)),updated};
      }
      return {tenant_id:before.tenant_id,before_captured_at:before.captured_at,after_captured_at:after.captured_at,changes,applied:false,_source:'computed'};
    },
  }];
}
