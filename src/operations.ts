import type { Env } from './env';
import { McpError } from './errors';
import { hashArgs } from './write-gate';
import { currentBudget } from './request-budget';
import { scrubDiagnostics } from './safe-error';

export type OperationState = 'accepted' | 'running' | 'verified' | 'failed-before-write' | 'outcome-unknown';
interface OperationRow { id: string; owner: string; role: string; tool: string; args_hash: string; state: OperationState; instance_id: string | null; result: string | null; updated_at: number }
export function operationEnvelope(row: OperationRow) {
  return { operation_id: row.id, state: row.state, ...(row.result ? { result: JSON.parse(row.result) } : {}), ...(row.instance_id ? { upstream_operation_id: row.instance_id } : {}), recovery: 'Use st_operation_status with operation_id. Do not submit another write while the outcome is unknown.' };
}
export async function operationStatus(env: Env, id: string, owner: string, role: string, allowedTools?: readonly string[]) {
  const row = await env.DB.prepare('SELECT * FROM mcp_operations WHERE id = ? AND owner = ? AND role = ?').bind(id, owner, role).first<OperationRow>();
  if (!row || (allowedTools && !allowedTools.includes(row.tool))) throw new McpError('not_found', 'Operation not found or not authorized');
  if (row.state === 'running' && Date.now() - row.updated_at > 650_000) row.state = 'outcome-unknown';
  return operationEnvelope(row);
}

export async function recoverableWrite(env: Env, tool: string, args: Record<string, unknown>, owner: string, role: string, run: () => Promise<unknown>): Promise<unknown> {
  const token = args.confirmation_token;
  if (typeof token !== 'string' || !token) throw new McpError('validation_error', 'confirmation_token required');
  const id = await hashArgs({ tenant: env.ST_TENANT_ID, owner, token, tool });
  const argsHash = await hashArgs(args);
  const claimed = await env.DB.prepare('INSERT OR IGNORE INTO mcp_operations (id, owner, role, tool, args_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner, role, tool, argsHash, 'accepted', Date.now(), Date.now()).run();
  if (claimed.meta?.changes !== 1) {
    const row = await env.DB.prepare('SELECT * FROM mcp_operations WHERE id = ? AND owner = ? AND role = ?').bind(id, owner, role).first<OperationRow>();
    if (!row || row.args_hash !== argsHash) throw new McpError('validation_error', 'Operation arguments or permissions differ from original submission');
    return operationEnvelope(row);
  }
  const budget = currentBudget();
  if (budget) budget.operationId = id;
  await env.DB.prepare('UPDATE mcp_operations SET state = ?, updated_at = ? WHERE id = ?').bind('running', Date.now(), id).run();
  try {
    const result = scrubDiagnostics(env, await run());
    const data = result as { verified?: boolean; outcome?: { remotely_verified?: boolean } } | null;
    const state = data?.verified === true || data?.outcome?.remotely_verified === true ? 'verified' : budget?.instanceId ? 'running' : 'outcome-unknown';
    const serialized = JSON.stringify(result ?? null);
    await env.DB.prepare('UPDATE mcp_operations SET state = ?, result = ?, updated_at = ? WHERE id = ?').bind(state, serialized.length <= 262144 ? serialized : null, Date.now(), id).run();
    return { ...(result && typeof result === 'object' ? result : { result }), operation_id: id, state };
  } catch (error) {
    const state = budget?.submitted ? 'outcome-unknown' : 'failed-before-write';
    await env.DB.prepare('UPDATE mcp_operations SET state = ?, updated_at = ? WHERE id = ?').bind(state, Date.now(), id).run();
    throw new McpError(state === 'outcome-unknown' ? 'verify_unavailable' : error instanceof McpError ? error.code : 'upstream_error', `Write ${state}; recover operation ${id}`, { details: { operation_id: id, state } });
  }
}
export async function rememberInstance(env: Env, instance: string): Promise<void> {
  const budget = currentBudget();
  if (!budget?.operationId) return;
  budget.instanceId = instance;
  await env.DB.prepare('UPDATE mcp_operations SET instance_id = ?, updated_at = ? WHERE id = ?').bind(instance, Date.now(), budget.operationId).run();
}
