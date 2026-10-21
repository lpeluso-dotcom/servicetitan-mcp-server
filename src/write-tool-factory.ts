import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { backendWrite } from './backend';
import { McpError } from './errors';
import { WriteGate } from './write-gate';
import { rewriteTenantPlaceholders } from './tenant';
import { cachePurgeNamespace } from './cache';
import type { ToolDef } from './tools/index';
import type { Env } from './env';

export type StWriteMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface WriteVerifyInput<TArgs> {
  env: Env;
  args: TArgs;
  
  endpoint: string;
  
  payload: unknown;
  
  result: unknown;
  actor: string;
  correlation: string;
}

export interface WriteVerifyResult {
  verified: boolean;
  
  mismatchedFields?: string[];
  
  note?: string;
}

export interface WriteToolSpec<TArgs> {
  name: string;
  description: string;
  
  zodSchema: Record<string, ZodTypeAny>;

  validate?: (args: TArgs) => void;
  
  endpoint: (args: TArgs) => string;
  
  method: StWriteMethod;
  
  payload: (args: TArgs) => unknown;

  businessArgs?: (args: TArgs) => Record<string, unknown>;

  stEndpointTemplate?: string;

  invalidatesCache?: (args: TArgs) => string[];

  tokenTtlMs?: number;

  verify?: (input: WriteVerifyInput<TArgs>) => Promise<WriteVerifyResult>;
}

const DRY_RUN_ZOD = z
  .boolean()
  .default(true)
  .describe('true (default) = preview + token; false = execute write');

const TOKEN_ZOD = z
  .string()
  .optional()
  .describe('Token from prior dryRun=true call');

interface BaseWriteArgs {
  dryRun?: boolean;
  confirmation_token?: string;
}

function defaultBusinessArgs<TArgs extends BaseWriteArgs>(args: TArgs): Record<string, unknown> {
  const { dryRun: _dr, confirmation_token: _ct, ...rest } = args as Record<string, unknown> &
    BaseWriteArgs;
  return rest;
}

export function defineWriteTool<TArgs extends BaseWriteArgs>(
  spec: WriteToolSpec<TArgs>
): ToolDef<TArgs> {
  return {
    name: spec.name,
    description: spec.description,
    isWrite: true,
    permission: "staff",
    ...(spec.stEndpointTemplate
      ? {
          stEndpoint: {
            method: spec.method,
            path: spec.stEndpointTemplate,
            source: 'live' as const,
          },
        }
      : {}),
    zodSchema: {
      ...spec.zodSchema,
      dryRun: DRY_RUN_ZOD,
      confirmation_token: TOKEN_ZOD,
    },
    async handler(env: Env, args: TArgs, { actor, correlation }) {
      if (spec.validate) {
        try {
          spec.validate(args);
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw new McpError('validation_error', e instanceof Error ? e.message : String(e), { correlation });
        }
      }
      const dryRun = args.dryRun ?? true;
      const confirmation_token = args.confirmation_token;
      const businessArgs = spec.businessArgs ? spec.businessArgs(args) : defaultBusinessArgs(args);
      const gate = new WriteGate(env);

      const endpoint = rewriteTenantPlaceholders(env, spec.endpoint(args));
      const payload = spec.payload(args);

      if (dryRun) {
        return gate.dryRun(spec.name, businessArgs, actor, correlation, payload, endpoint, spec.method, spec.tokenTtlMs);
      }
      if (!confirmation_token) {
        throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
      }
      await gate.verifyToken(spec.name, businessArgs, actor, confirmation_token);

      const resp = await backendWrite(env, { endpoint, method: spec.method, payload }, {
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlation,
          'x-actor': actor,
        },
      });
      if (!resp.ok) {
        throw new McpError('upstream_error', `${spec.name} failed: ${resp.status}`, { correlation });
      }
      const result = await resp.json();
      if (spec.invalidatesCache) {
        const namespaces = spec.invalidatesCache(args);
        await Promise.all(namespaces.map((ns) => cachePurgeNamespace(env, ns)));
      }
      if (!spec.verify) return { dryRun: false, tool: spec.name, result, correlation };

      // The write already landed. A failed read-back must never turn that into
      // a thrown error (the caller would retry a write that succeeded); it is
      // reported as written-but-unverified instead.
      let check: WriteVerifyResult;
      try {
        check = await spec.verify({ env, args, endpoint, payload, result, actor, correlation });
      } catch (e) {
        check = { verified: false, note: `read-back failed${e instanceof McpError ? ` (${e.code})` : ''}` };
      }
      return {
        dryRun: false,
        tool: spec.name,
        result,
        correlation,
        verified: check.verified,
        outcome: {
          remotely_verified: check.verified,
          ...(check.mismatchedFields && check.mismatchedFields.length > 0 ? { mismatched_fields: check.mismatchedFields } : {}),
          ...(check.note ? { note: check.note } : {}),
        },
      };
    },
  };
}
