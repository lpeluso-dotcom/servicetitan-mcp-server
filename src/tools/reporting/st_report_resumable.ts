import { z } from 'zod';
import { authHeaders } from '../../auth';
import { McpError, mapUpstreamStatus } from '../../errors';
import { guardedStFetch } from '../../rate-limit-guard';
import { scopeFor } from '../../scope';
import { rewriteTenantPlaceholders } from '../../tenant';
import { hashArgs } from '../../write-gate';
import type { Env } from '../../env';
import type { ToolContext, ToolDef } from '../index';
import { reportRunIdentity } from './report-identity';
import { backendRead } from '../../backend';

const REPORT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
type State = 'starting' | 'pending' | 'completed' | 'partial' | 'failed' | 'cancelled';
interface RunRow { id:string; owner:string; role:string; category_id:string; report_id:string; request_json:string; token:string|null; state:State; result:string|null; error:string|null; updated_at:number; expires_at:number }

function requestContext(ctx: ToolContext) { return { actor: ctx.actor, principal: ctx.principal, role: ctx.role ?? 'default' } as const; }
function tokenFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const key of ['token', 'queryToken', 'id']) { const value = (body as Record<string, unknown>)[key]; if (typeof value === 'string' && value.length > 0) return value; }
  return null;
}
function publicRun(row: RunRow, includeResult = false) {
  return {
    report_run_id: row.id, state: row.state, categoryId: row.category_id, reportId: row.report_id,
    updated_at: new Date(row.updated_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(),
    ...(includeResult && row.result ? { result: JSON.parse(row.result) } : {}), ...(row.error ? { error: row.error } : {}),
    recovery: row.state === 'pending' || row.state === 'starting' ? 'Call st_report_status with report_run_id. Do not submit the report again.'
      : row.state === 'completed' || row.state === 'partial' ? 'Call st_report_results with report_run_id to retrieve the persisted result.'
      : 'Review the failure and start a new run only if the request should be retried.',
    _source: 'live-st-reporting+persistent-d1-state',
  };
}
async function ownedRun(env: Env, id: string, ctx: ToolContext): Promise<RunRow | null> {
  const owner = scopeFor(env, requestContext(ctx));
  return env.DB.prepare('SELECT id, owner, role, category_id, report_id, request_json, token, state, result, error, updated_at, expires_at FROM mcp_report_runs WHERE id = ? AND owner = ? AND role = ?')
    .bind(id, owner, ctx.role ?? 'default').first<RunRow>();
}
const runIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const st_report_start: ToolDef = {
  name: 'st_report_start', title: 'Start ServiceTitan report', permission: 'staff', isWrite: false,
  description: 'Start one ServiceTitan native report without long polling. Persists caller ownership and returns completed inline data or a resumable report_run_id. page defaults to 1 and pageSize defaults to 100 with a 5000-row cap. Use describe_report first. Source: live ST plus persisted operation state.',
  zodSchema: { categoryId:z.union([z.string(),z.number()]), reportId:z.union([z.string(),z.number()]), parameters:z.array(z.object({name:z.string(),value:z.unknown()})), page:z.number().int().positive().optional(), pageSize:z.number().int().positive().max(5000).optional() },
  stEndpoint: { method:'POST', path:'/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data/query', source:'live' },
  async handler(env, args: any, ctx) {
    if (!ctx.principal) throw new McpError('auth_failed', 'Authenticated identity required for resumable reports', { correlation:ctx.correlation });
    const request = { categoryId:args.categoryId, reportId:args.reportId, parameters:args.parameters, page:args.page??1, pageSize:args.pageSize??100 };
    const owner = scopeFor(env, requestContext(ctx));
    const id = await hashArgs({ owner, identity:reportRunIdentity(request) });
    const existing = await ownedRun(env,id,ctx);
    if (existing && existing.expires_at>Date.now()) return publicRun(existing, ['completed','partial'].includes(existing.state));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO mcp_report_runs (id,owner,role,category_id,report_id,request_json,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,'starting',?,?,?) ON CONFLICT(id) DO UPDATE SET token=NULL,state='starting',result=NULL,error=NULL,request_json=excluded.request_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
      .bind(id,owner,ctx.role??'default',String(args.categoryId),String(args.reportId),JSON.stringify(request),now,now,now+REPORT_EXPIRY_MS).run();
    const path=rewriteTenantPlaceholders(env,`/reporting/v2/tenant/000000000/report-category/${args.categoryId}/reports/${args.reportId}/data/query?page=${request.page}&pageSize=${request.pageSize}`);
    let response:Response;
    try { response=await guardedStFetch(env,path,()=>backendRead(env,path,{method:'POST',headers:{...authHeaders(env,ctx.correlation,ctx.actor),'content-type':'application/json'},body:JSON.stringify({parameters:args.parameters}),signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)}),{identity:reportRunIdentity(request)}); }
    catch(error){ await env.DB.prepare("UPDATE mcp_report_runs SET state='failed',error=?,updated_at=? WHERE id=? AND owner=?").bind('Report submission failed before a query token was confirmed.',Date.now(),id,owner).run(); throw error; }
    if(response.status===200){ const result=await response.json(); const state:State=result&&typeof result==='object'&&(result as any)._partial===true?'partial':'completed'; await env.DB.prepare('UPDATE mcp_report_runs SET state=?,result=?,updated_at=? WHERE id=? AND owner=?').bind(state,JSON.stringify(result),Date.now(),id,owner).run(); }
    else if(response.status===202){ const token=tokenFrom(await response.json().catch(()=>({}))); if(!token) { await env.DB.prepare("UPDATE mcp_report_runs SET state='failed',error=?,updated_at=? WHERE id=? AND owner=?").bind('Report accepted but no supported query token was returned.',Date.now(),id,owner).run(); throw new McpError('upstream_error','Report accepted but no supported query token was returned',{correlation:ctx.correlation}); } await env.DB.prepare("UPDATE mcp_report_runs SET state='pending',token=?,updated_at=? WHERE id=? AND owner=?").bind(token,Date.now(),id,owner).run(); }
    else { const message=`Report submission failed with upstream status ${response.status}.`; await env.DB.prepare("UPDATE mcp_report_runs SET state='failed',error=?,updated_at=? WHERE id=? AND owner=?").bind(message,Date.now(),id,owner).run(); throw new McpError(mapUpstreamStatus(response.status),message,{correlation:ctx.correlation}); }
    return publicRun((await ownedRun(env,id,ctx))!,true);
  },
};

export const st_report_status: ToolDef = {
  name:'st_report_status', title:'Check ServiceTitan report', permission:'staff', isWrite:false,
  description:'Perform one bounded status check for a persisted report run. Never waits in a polling loop or resubmits. Ownership, role and expiry are enforced. Source: live ST plus persisted operation state.',
  zodSchema:{report_run_id:runIdSchema}, stEndpoint:{method:'GET',path:'/reporting/v2/tenant/{tid}/data-queries/{token}',source:'live'},
  async handler(env,args:any,ctx){
    const row=await ownedRun(env,args.report_run_id,ctx); if(!row) throw new McpError('validation_error','Report run not found or not authorized',{correlation:ctx.correlation});
    if(row.expires_at<=Date.now()) return {...publicRun({...row,state:'failed',error:'Report run expired.'}),state:'expired'};
    if(row.state!=='pending'||!row.token) return publicRun(row);
    const path=rewriteTenantPlaceholders(env,`/reporting/v2/tenant/000000000/data-queries/${encodeURIComponent(row.token)}`);
    const response=await guardedStFetch(env,path,()=>backendRead(env,path,{headers:authHeaders(env,ctx.correlation,ctx.actor),signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)}));
    if(response.status===202) return publicRun(row);
    if(response.status===200){ const result=await response.json(); const state:State=result&&typeof result==='object'&&(result as any)._partial===true?'partial':'completed'; await env.DB.prepare('UPDATE mcp_report_runs SET state=?,result=?,updated_at=? WHERE id=? AND owner=?').bind(state,JSON.stringify(result),Date.now(),row.id,row.owner).run(); return publicRun((await ownedRun(env,row.id,ctx))!); }
    const state:State=response.status===410?'cancelled':'failed'; const error=`Report status check returned upstream status ${response.status}.`; await env.DB.prepare('UPDATE mcp_report_runs SET state=?,error=?,updated_at=? WHERE id=? AND owner=?').bind(state,error,Date.now(),row.id,row.owner).run(); return publicRun((await ownedRun(env,row.id,ctx))!);
  },
};

export const st_report_results: ToolDef = {
  name:'st_report_results', title:'Retrieve ServiceTitan report results', permission:'staff', isWrite:false,
  description:'Retrieve a completed or partial persisted report result without polling or resubmitting. Large results use the connector authenticated result-page contract. Ownership, role and expiry are enforced. Source: a persisted result from live ST reporting.',
  zodSchema:{report_run_id:runIdSchema}, stEndpoint:{method:'GET',path:'local:report-runs',source:'computed'},
  async handler(env,args:any,ctx){ const row=await ownedRun(env,args.report_run_id,ctx); if(!row) throw new McpError('validation_error','Report run not found or not authorized',{correlation:ctx.correlation}); if(row.expires_at<=Date.now()) return {...publicRun({...row,state:'failed',error:'Report run expired.'}),state:'expired'}; return publicRun(row,['completed','partial'].includes(row.state)); },
};
