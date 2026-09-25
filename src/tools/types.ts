import type { z } from 'zod';
import type { Env } from '../env';


export type Tier = 'core' | 'internal';

export interface ToolContext {
  actor: string;
  correlation: string;
  principal?: string;
  role?: 'default' | 'admin' | 'lockdown' | 'readonly';
  availableTools?: readonly string[];
}

export interface StEndpointDescriptor {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  
  path: string;
  source: 'live' | 'd1' | 'mixed' | 'computed';
}

export interface ToolDef<Args = Record<string, unknown>> {
  name: string;
  description: string;
  
  zodSchema: z.ZodRawShape;
  
  title?: string;

  outputSchema?: z.ZodRawShape;
  
  annotations?: Partial<{ title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }>;
  
  uiResourceUri?: `ui://${string}`;
  
  isWrite: boolean;
  permission: "staff" | "admin";
  
  adminOnly?: boolean;
  
  stEndpoint?: StEndpointDescriptor;
  handler: (env: Env, args: Args, ctx: ToolContext) => Promise<unknown>;

  transformResult?: (result: unknown) => unknown;
}
