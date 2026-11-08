import { withWriteLease } from '../../write-lease';
import { z } from 'zod';
import type { ToolDef, ToolContext } from '../index';
import type { Env } from '../../env';
import { readST } from '../../st';
import { WriteGate, hashArgs } from '../../write-gate';
import { McpError } from '../../errors';
import { sendConfigurationWrite } from './transport';

interface Spec {
  plural: string;
  singular: string;
  path: string;
  query: z.ZodObject;
  create?: z.ZodObject;
  update: z.ZodObject;
  listOnlyDetail: boolean;
  metadataOnly: boolean;
}
type Row = Record<string, unknown>;
const id = z.number().int().positive().safe();
const row = z.record(z.string(), z.unknown());
const record = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new McpError('upstream_error', 'Expected a ServiceTitan record');
  return v as Row;
};
const pathFor = (env: Env, spec: Spec) => {
  if (!env.ST_TENANT_ID || !/^\d+$/.test(env.ST_TENANT_ID)) throw new McpError('config_error', 'ST_TENANT_ID is required');
  return spec.path.replace('{tid}', env.ST_TENANT_ID);
};

async function list(env: Env, ctx: ToolContext, spec: Spec, args: Row) {
  const query = spec.query.parse(args);
  const result = record(await readST(env, ctx, pathFor(env, spec), query));
  if (!Array.isArray(result.data) || typeof result.hasMore !== 'boolean') {
    throw new McpError('upstream_error', 'Configuration list has malformed pagination');
  }
  if (result.page !== undefined && result.page !== query.page) throw new McpError('upstream_error', 'Configuration list returned the wrong page');
  if (result.data.length > Number(query.pageSize)) throw new McpError('upstream_error', 'Configuration page exceeds the requested size');
  const data = result.data.map(record);
  const ids = typeof query.ids === 'string' ? new Set(query.ids.split(',').map(Number)) : undefined;
  for (const value of data) {
    if (ids && !ids.has(Number(value.id))) throw new McpError('upstream_error', 'ServiceTitan ignored the IDs filter');
    if (query.active === 'True' && value.active !== true || query.active === 'False' && value.active !== false) {
      throw new McpError('upstream_error', 'ServiceTitan ignored the active filter');
    }
  }
  return { data, page: Number(query.page), has_more: result.hasMore, total_count: typeof result.totalCount === 'number' ? result.totalCount : null, _source: 'live' };
}

async function detail(env: Env, ctx: ToolContext, spec: Spec, objectId: number, applicationGuid?: string): Promise<Row> {
  if (!spec.listOnlyDetail) {
    const result = record(await readST(env, ctx, `${pathFor(env, spec)}/${objectId}`, applicationGuid ? { externalDataApplicationGuid: applicationGuid } : {}));
    if (result.id !== objectId) throw new McpError('upstream_error', 'Configuration detail returned the wrong ID');
    return result;
  }
  // Tag types have no GET-by-ID endpoint. Refuse to infer absence from an incomplete scan.
  for (let page = 1; page <= 20; page++) {
    const result = await list(env, ctx, spec, { active: 'Any', page, pageSize: 200 });
    const matches = result.data.filter(value => value.id === objectId);
    if (matches.length > 1) throw new McpError('upstream_error', 'Duplicate configuration IDs');
    if (matches.length === 1) return matches[0];
    if (!result.has_more) throw new McpError('validation_error', 'Configuration record not found');
  }
  throw new McpError('upstream_error', 'Tag lookup reached its scan limit; result is incomplete');
}

function expectedFields(before: Row | null, changes: Row, metadataOnly: boolean): Row {
  if (!metadataOnly) return changes;
  const request = record(changes.externalData);
  const entries = request.externalData as Array<{ key: string; value: unknown }>;
  const values = new Map<string, unknown>();
  if (request.patchMode === 'Merge' && Array.isArray(before?.externalData)) {
    for (const item of before.externalData) { const value = record(item); values.set(String(value.key), value.value); }
  }
  for (const entry of entries) {
    if (entry.value == null) values.delete(entry.key); else values.set(entry.key, entry.value);
  }
  return { externalData: [...values].sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => ({ key, value })) };
}

export function configurationTools(spec: Spec): ToolDef<any>[] {
  const listTool: ToolDef<Row> = {
    name: `list_${spec.plural}`, permission: 'staff', isWrite: false,
    description: `List ${spec.plural.replaceAll('_',' ')} with explicit pagination: default page size 50, max 200; has_more indicates another page. Source: live ST.`,
    zodSchema: spec.query.shape,
    outputSchema: { data: z.array(row), page: z.number(), has_more: z.boolean(), total_count: z.number().nullable(), _source: z.string() },
    stEndpoint: { method: 'GET', path: spec.path, source: 'live' },
    handler: (env,args,ctx) => list(env,ctx,spec,args),
  };
  const detailSchema = z.object({ id, ...(!spec.listOnlyDetail ? { externalDataApplicationGuid: z.string().uuid().optional() } : {}) }).strict();
  const getTool: ToolDef<z.infer<typeof detailSchema>> = {
    name: `get_${spec.singular}`, permission:'staff', isWrite:false,
    description: `Get one ${spec.singular.replaceAll('_',' ')} by ID. ${spec.listOnlyDetail ? 'Scans up to 4,000 tag types; fails explicitly at the cap.' : ''} Source: live ST.`,
    zodSchema:detailSchema.shape, outputSchema:{ record:row, _source:z.string() },
    stEndpoint:{ method:'GET', path:spec.path+(spec.listOnlyDetail?'':'/{id}'), source:'live' },
    async handler(env,args,ctx) { const parsed=detailSchema.parse(args);return { record:await detail(env,ctx,spec,parsed.id,typeof parsed.externalDataApplicationGuid === "string" ? parsed.externalDataApplicationGuid : undefined),_source:'live' }; },
  };
  const writes = (['create','update'] as const).flatMap(action => {
    const bodySchema=spec[action]; if (!bodySchema) return [];
    const name=`${action}_${spec.singular}${spec.metadataOnly?'_metadata':''}`;
    const input=z.object({ ...(action==='update'?{id}:{}), changes:bodySchema.refine(v=>Object.keys(v).length>0,'At least one change is required'), dryRun:z.boolean().default(true), confirmation_token:z.string().optional() }).strict();
    const tool:ToolDef<any>={
      name, permission:'admin', adminOnly:true, isWrite:true,
      description:`${action==='create'?'Create':'Update'} ${spec.singular.replaceAll('_',' ')}${spec.metadataOnly?' external metadata only; ordinary business-unit settings are not writable through this endpoint':''}. Source: live ST. dryRun=true → confirmation_token → dryRun=false. Updates reject changed records since preview. Read-back verifies written fields. Requires configuration writes enabled. Never retry an unknown outcome.`,
      zodSchema:input.shape,
      stEndpoint:{method:action==='create'?'POST':'PATCH',path:spec.path+(action==='update'?'/{id}':''),source:'live'},
      annotations:{destructiveHint:true,idempotentHint:false},
      outputSchema:{dryRun:z.boolean(),tool:z.string(),confirmation_token:z.string().optional(),expires_in_seconds:z.number().optional(),payload:z.unknown().optional(),st_endpoint:z.string().optional(),st_method:z.string().optional(),current:row.nullable().optional(),proposed:row.optional(),state:z.string().optional(),result:z.unknown().optional(),verified:z.boolean().optional(),mismatched_fields:z.array(z.string()).optional(),note:z.string().optional(),correlation:z.string().optional()},
      async handler(env,args,ctx) {
        if(ctx.role!=='admin') throw new McpError('auth_failed','Configuration writes require an admin identity');
        if(env.CONFIGURATION_WRITES_ENABLED!=='true') throw new McpError('config_error','Configuration writes are disabled; enable only after integration validation');
        const parsed=input.parse(args); const changes=parsed.changes as Row;
        const objectId='id' in parsed?Number(parsed.id):undefined;
        const run = async () => {
          const guid=spec.metadataOnly?String(record(changes.externalData).applicationGuid):undefined;
          const current=objectId?await detail(env,ctx,spec,objectId,guid):null;
          const proposed=expectedFields(current,changes,spec.metadataOnly);
          const businessArgs={tenant:env.ST_TENANT_ID,principal:ctx.principal??ctx.actor,id:objectId,changes,currentHash:await hashArgs(current??{})};
          const endpoint=pathFor(env,spec)+(objectId?`/${objectId}`:'');
          const method=action==='create'?'POST':'PATCH'; const gate=new WriteGate(env);
          if(parsed.dryRun) return {...await gate.dryRun(name,businessArgs,ctx.actor,ctx.correlation,changes,endpoint,method),current,proposed};
          if(!parsed.confirmation_token) throw new McpError('validation_error','confirmation_token required');
          await gate.verifyToken(name,businessArgs,ctx.actor,parsed.confirmation_token);
          // ST has no conditional update here: the read-to-write race cannot be eliminated.
          let result:unknown;
          try { result=await sendConfigurationWrite(env,ctx,endpoint,method,changes); }
          catch { return {dryRun:false,tool:name,state:'outcome-unknown',verified:false,note:'Write outcome is uncertain. Inspect operation status and ServiceTitan before retrying.',correlation:ctx.correlation}; }
          try {
            const response=record(result);const body=record(response.response??response);
            const createdId=objectId??id.parse(body.id);
            const after=await detail(env,ctx,spec,createdId,guid);
            if(spec.metadataOnly && Array.isArray(after.externalData)) after.externalData=[...after.externalData].sort((a,b)=>String(a.key).localeCompare(String(b.key)));
            const mismatched:string[]=[];
            for(const [key,value] of Object.entries(proposed)) {
              if(await hashArgs({value})!==await hashArgs({value:after[key]})) mismatched.push(key);
            }
            return {dryRun:false,tool:name,result,verified:mismatched.length===0,state:mismatched.length?'outcome-unknown':'verified',mismatched_fields:mismatched,correlation:ctx.correlation};
          } catch { return {dryRun:false,tool:name,result,verified:false,state:'outcome-unknown',note:'Write accepted but read-back could not verify it. Do not resubmit.',correlation:ctx.correlation}; }
        };
        return parsed.dryRun || !objectId ? run() : withWriteLease(env, `configuration:${pathFor(env,spec)}/${objectId}`, run);
      },
    };
    return [tool];
  });
  return [listTool,getTool,...writes];
}
