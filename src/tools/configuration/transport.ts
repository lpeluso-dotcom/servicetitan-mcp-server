import type { Env } from '../../env';
import type { ToolContext } from '../index';
import { backendWrite } from '../../backend';
import { guardedStFetch } from '../../rate-limit-guard';
import { McpError } from '../../errors';

export async function sendConfigurationWrite(env:Env,ctx:ToolContext,endpoint:string,method:string,payload:unknown):Promise<unknown> {
  const response=await guardedStFetch(env,endpoint,()=>backendWrite(env,{endpoint,method,payload},{headers:{'content-type':'application/json','x-actor':ctx.actor,'x-correlation-id':ctx.correlation}}));
  if(!response.ok) throw new McpError('upstream_error',`Configuration write returned HTTP ${response.status}`);
  return response.json();
}
