import { withWriteLease } from '../../write-lease';
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { sendConfigurationWrite } from '../configuration/transport';
import type { ToolDef, ToolContext } from '../index';
import type { Env } from '../../env';

const input = z.object({
  appointmentId: z.number().int().positive().safe(),
  technicianIds: z.array(z.number().int().positive().safe()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Technician IDs must be unique'),
  dryRun: z.boolean().default(true), confirmation_token: z.string().optional(),
}).strict();
const base = (env:Env) => `/dispatch/v2/tenant/${env.ST_TENANT_ID ?? '000000000'}/appointment-assignments`;
async function assigned(env:Env,ctx:ToolContext,appointmentId:number):Promise<number[]> {
  const ids=new Set<number>();
  for(let page=1;page<=5;page++) {
    const result=await readST<{data?:Array<{appointmentId:number;technicianId:number;active:boolean}>;hasMore?:boolean;page?:number}>(env,ctx,base(env),{appointmentIds:String(appointmentId),active:'True',page,pageSize:200});
    if(!Array.isArray(result.data)||typeof result.hasMore!=='boolean'||result.page!==undefined&&result.page!==page) throw new McpError('upstream_error','Assignment list pagination is malformed');
    for(const row of result.data) {
      if(row.appointmentId!==appointmentId||row.active!==true||!Number.isSafeInteger(row.technicianId)||row.technicianId<=0) throw new McpError('upstream_error','Assignment response did not preserve the appointment and active filters');
      ids.add(row.technicianId);
    }
    if(!result.hasMore) return [...ids].sort((a,b)=>a-b);
  }
  throw new McpError('upstream_error','Assignment lookup reached its page cap');
}

// Deliberately withheld from the served catalog until an integration canary is recorded.
export const assign_technicians:ToolDef<z.input<typeof input>>={
  name:'assign_technicians',permission:'staff',isWrite:true,
  description:'Replace appointment technicians using the documented dispatch API. Source: live ST. Reads current assignments, previews only additions/removals, assigns additions first, then removes obsolete assignments. This is not atomic. dryRun=true → confirmation_token → dryRun=false. Read-back verifies the final set. Never retry a partial or unknown outcome.',
  zodSchema:input.shape,
  stEndpoint:{method:'POST',path:'/dispatch/v2/tenant/{tid}/appointment-assignments/assign-technicians',source:'live'},
  annotations:{destructiveHint:true,idempotentHint:false},
  async handler(env,args,ctx) {
    const parsed=input.parse(args);const {appointmentId,confirmation_token,dryRun}=parsed;
    const run = async () => {
      const target=[...parsed.technicianIds].sort((a,b)=>a-b);
      const before=await assigned(env,ctx,appointmentId);
      const additions=target.filter(id=>!before.includes(id));const removals=before.filter(id=>!target.includes(id));
      const steps=[
        ...(additions.length?[{endpoint:`${base(env)}/assign-technicians`,payload:{jobAppointmentId:appointmentId,technicianIds:additions}}]:[]),
        ...(removals.length?[{endpoint:`${base(env)}/unassign-technicians`,payload:{jobAppointmentId:appointmentId,technicianIds:removals}}]:[]),
      ];
      const businessArgs={tenant:env.ST_TENANT_ID,principal:ctx.principal??ctx.actor,appointmentId,technicianIds:target,before};
      const gate=new WriteGate(env);
      if(dryRun) return {...await gate.dryRun('assign_technicians',businessArgs,ctx.actor,ctx.correlation,{before,after:target,steps},`${base(env)}/assign-technicians`,'POST'),non_atomic:true};
      if(!confirmation_token) throw new McpError('validation_error','confirmation_token required');
      await gate.verifyToken('assign_technicians',businessArgs,ctx.actor,confirmation_token);
      const completedSteps:string[]=[];
      for(const step of steps) {
        try {await sendConfigurationWrite(env,ctx,step.endpoint,'POST',step.payload);completedSteps.push(step.endpoint);}
        catch {return {dryRun:false,tool:'assign_technicians',verified:false,state:'outcome-unknown',completed_steps:completedSteps,failed_step:step.endpoint,before,requested:target,note:'Partial changes may exist. Inspect assignments before any retry; no automatic rollback was attempted.'};}
      }
      try {
        const after=await assigned(env,ctx,appointmentId);const verified=JSON.stringify(after)===JSON.stringify(target);
        return {dryRun:false,tool:'assign_technicians',verified,state:verified?'verified':'outcome-unknown',before,after,requested:target,completed_steps:completedSteps};
      } catch {return {dryRun:false,tool:'assign_technicians',verified:false,state:'outcome-unknown',completed_steps:completedSteps,note:'Writes completed but read-back failed. Inspect ServiceTitan; do not resubmit.'};}
    };
    return dryRun ? run() : withWriteLease(env, `assignment:${base(env)}/${appointmentId}`, run);
  },
};
