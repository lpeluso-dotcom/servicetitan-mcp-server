// st_patch_service: PATCH a pricebook service by ID.
// dryRun=true (default) returns a confirmation_token; dryRun=false + token writes.
import { z } from 'zod';
import { McpError } from '../errors';
import { defineWriteTool } from '../write-tool-factory';
import { toStPricebookPayload, verifyPricebookWrite } from './pricebook-payload';

interface Args {
  id: number;
  name?: string;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  memberPrice?: number;
  useStaticPrices?: boolean;
  hours?: number;
  isLabor?: boolean;
  taxable?: boolean;
  account?: string;
  paysCommission?: boolean;
  active?: boolean;
  categoryId?: number;
  categories?: number[];
  dryRun?: boolean;
  confirmation_token?: string;
}

function fields({ id: _id, dryRun: _d, confirmation_token: _t, ...rest }: Args) {
  return rest;
}

export const st_patch_service = defineWriteTool<Args>({
  name: 'st_patch_service',
  description:
    'PATCH a ServiceTitan pricebook service by ID. ' +
    'dryRun=true (default) returns a confirmation_token; call again with dryRun=false + token to write. ' +
    'Pricing mode follows useStaticPrices: when false, ServiceTitan computes price at invoice time (dynamic pricing), so do not set price/memberPrice unless useStaticPrices=true. ' +
    'Note: useStaticPrices cannot be flipped from false→true via PATCH on a service that was created without it (ST silently drops it). Use ST UI to flip. ' +
    'Source: live ST.',
  zodSchema: {
    id: z.number().int().positive().describe('ST pricebook service ID'),
    name: z.string().optional().describe('Display name (rewritten to displayName before submit)'),
    code: z.string().optional().describe('Service code (e.g. "HVAC-DIAG-01")'),
    description: z.string().optional().describe('Service description shown on invoices'),
    cost: z.number().optional().describe('Internal cost (required for correct job costing)'),
    price: z.number().optional().describe('Static price. Only meaningful when useStaticPrices=true.'),
    memberPrice: z.number().optional().describe('Member-tier static price. Only meaningful when useStaticPrices=true.'),
    useStaticPrices: z.boolean().optional().describe('Plural — the field ST actually accepts. CAN ONLY BE FLIPPED via UI post-create — PATCH attempts silently drop.'),
    hours: z.number().optional().describe('Labor hours (used for cost calc on isLabor=true services)'),
    isLabor: z.boolean().optional().describe('true = labor line item; false = part/equipment/fee'),
    taxable: z.boolean().optional().describe('Whether the service is taxable'),
    account: z.string().optional().describe('GL account name (e.g. "Revenue")'),
    paysCommission: z.boolean().optional().describe('Whether commission applies on sale'),
    active: z.boolean().optional().describe('Whether the service is active in the pricebook'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID (single-cat shortcut; pass categories[] for multi-cat)'),
    categories: z.array(z.number().int().positive()).min(1).optional().describe('Multi-category. If passed, takes precedence over categoryId.'),
  },
  validate(args) {
    if (Object.keys(fields(args)).length === 0) {
      throw new McpError('validation_error', 'st_patch_service requires at least one field to update besides id');
    }
  },
  endpoint: ({ id }) => `/pricebook/v2/tenant/000000000/services/${id}`,
  method: 'PATCH',
  // The token binds the user-facing shape; the outbound payload is rewritten
  // for ServiceTitan (name to displayName, categoryId to categories[]).
  payload: (args) => toStPricebookPayload(fields(args)),
  businessArgs: (args) => ({ id: args.id, ...fields(args) }),
  stEndpointTemplate: '/pricebook/v2/tenant/{tid}/services/{id}',
  tokenTtlMs: 5 * 60 * 1000,
  verify: verifyPricebookWrite('services'),
});
