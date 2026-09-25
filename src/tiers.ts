import type { Tier, ToolDef } from './tools/types';
import { PUBLIC_TOOLS } from './tools/public-registry';

export type { Tier };

export function toolTier(tool: ToolDef<any>): Tier {
  return PUBLIC_TOOLS.includes(tool) ? 'core' : 'internal';
}

export const RESOURCE_MODULE_TIERS: Readonly<Record<string, Tier>> = {
  'src/resources/results.ts': 'core',
};
