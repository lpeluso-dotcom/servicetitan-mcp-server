// Public tool registry. Generated from src/tools/public-registry.ts.
import type { ToolDef } from './types';
import { PUBLIC_TOOLS } from './public-registry';
import { filterToolsForRole, type ToolRole } from './role-filter';

export type { ToolContext, StEndpointDescriptor, ToolDef, Tier } from './types';

export const TOOLS: readonly ToolDef<any>[] = PUBLIC_TOOLS;

export function findTool(name: string): ToolDef<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolsForRole(role: ToolRole): readonly ToolDef<any>[] {
  return filterToolsForRole(TOOLS, role);
}
