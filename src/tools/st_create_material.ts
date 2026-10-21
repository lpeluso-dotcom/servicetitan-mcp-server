// st_create_material: POST a new pricebook material.
// dryRun=true (default) returns a confirmation_token; dryRun=false + token writes.
import { z } from 'zod';
import { McpError } from '../errors';
import { defineWriteTool } from '../write-tool-factory';
import { toStPricebookPayload, verifyPricebookWrite } from './pricebook-payload';

interface Args {
  name: string;
  categoryId: number;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  active?: boolean;
  unitOfMeasure?: string;
  primaryVendor?: { vendorId: number; cost?: number; active?: boolean };
  primaryVendorId?: number;
  primaryVendorCost?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

type ResolvedVendor = { vendorId: number; cost?: number; active: boolean };

// ST requires exactly one primary vendor on material create. Accept either a
// nested primaryVendor object or the flat primaryVendorId/primaryVendorCost
// shorthand; default the vendor cost to the material cost. Returns null when
// no vendor was supplied (the caller turns that into a validation_error).
function resolvePrimaryVendor(
  nested: Args['primaryVendor'],
  flatId: number | undefined,
  flatCost: number | undefined,
  materialCost: number | undefined,
): ResolvedVendor | null {
  if (nested && typeof nested.vendorId === 'number') {
    return { vendorId: nested.vendorId, cost: nested.cost ?? materialCost, active: nested.active ?? true };
  }
  if (typeof flatId === 'number') {
    return { vendorId: flatId, cost: flatCost ?? materialCost, active: true };
  }
  return null;
}

// The material as sent to ServiceTitan, in the user-facing shape: the flat
// vendor shorthand is folded into a resolved primaryVendor object.
function resolvedMaterial(args: Args): Record<string, unknown> {
  const { dryRun: _d, confirmation_token: _t, primaryVendorId, primaryVendorCost, ...rest } = args;
  const vendor = resolvePrimaryVendor(rest.primaryVendor, primaryVendorId, primaryVendorCost, rest.cost);
  if (!vendor) {
    throw new McpError('validation_error',
      'primaryVendor is required: ServiceTitan rejects a material create without exactly one primary vendor. ' +
      'Pass primaryVendor:{vendorId,…} or primaryVendorId.');
  }
  return { ...rest, primaryVendor: vendor };
}

export const st_create_material = defineWriteTool<Args>({
  name: 'st_create_material',
  description:
    'Create a new ServiceTitan pricebook material. ' +
    'dryRun=true (default) returns a confirmation_token; call again with dryRun=false + token to write. ' +
    'Requires name and categoryId at minimum. A primary vendor is also required ' +
    '(primaryVendor:{vendorId} or the flat primaryVendorId) — ST rejects a material create without exactly one primary vendor. ' +
    'A 0 or null price can mean the item is priced dynamically; set price only if you want a static price. ' +
    'Source: live ST.',
  zodSchema: {
    name: z.string().min(1).describe('Display name for the material'),
    categoryId: z.number().int().positive().describe('Pricebook category ID (required by ST)'),
    code: z.string().optional().describe('Material code'),
    description: z.string().optional().describe('Material description'),
    cost: z.number().optional().describe('Internal cost per unit'),
    price: z.number().optional().describe('Price per unit charged to the customer'),
    active: z.boolean().optional().describe('Whether active in pricebook (default true)'),
    unitOfMeasure: z.string().optional().describe('Unit of measure (e.g. "Each", "Box")'),
    primaryVendor: z.object({
      vendorId: z.number().int().positive().describe('ST vendor ID (see inventory_vendors_list)'),
      cost: z.number().optional().describe('Vendor cost per unit; defaults to the material cost when omitted'),
      active: z.boolean().default(true).describe('Whether this vendor link is active'),
    }).optional().describe('Primary vendor — REQUIRED by ST (exactly one). Supply this or primaryVendorId.'),
    primaryVendorId: z.number().int().positive().optional().describe('Shorthand: primary vendor ID (alternative to the primaryVendor object)'),
    primaryVendorCost: z.number().optional().describe('Shorthand: primary vendor cost (used with primaryVendorId; defaults to material cost)'),
  },
  validate(args) {
    resolvedMaterial(args);
  },
  endpoint: () => '/pricebook/v2/tenant/000000000/materials',
  method: 'POST',
  payload: (args) => toStPricebookPayload(resolvedMaterial(args)),
  businessArgs: (args) => resolvedMaterial(args),
  stEndpointTemplate: '/pricebook/v2/tenant/{tid}/materials',
  tokenTtlMs: 5 * 60 * 1000,
  verify: verifyPricebookWrite('materials'),
});
