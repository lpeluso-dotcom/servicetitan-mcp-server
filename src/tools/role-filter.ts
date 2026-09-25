import type { ToolDef } from './types';

export type ToolRole = 'default' | 'admin' | 'lockdown' | 'readonly';

export function filterToolsForRole(tools: readonly ToolDef<any>[], role: ToolRole): readonly ToolDef<any>[] {
  const declared = tools.filter((t) => typeof t.isWrite === 'boolean' && ['staff', 'admin'].includes(t.permission));
  if (role === 'lockdown' || role === 'readonly') {
    return declared.filter((t) => t.isWrite === false && !t.adminOnly && t.permission === 'staff');
  }
  if (role === 'admin') return declared;
  return declared.filter((t) => !t.adminOnly && t.permission === 'staff');
}
