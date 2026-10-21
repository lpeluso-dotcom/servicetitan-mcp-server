// st_create_service: POST a new pricebook service.
// dryRun=true (default) returns a confirmation_token; dryRun=false + token writes.
import { z } from 'zod';
import { McpError } from '../errors';
import { defineWriteTool } from '../write-tool-factory';
import { toStPricebookPayload, verifyPricebookWrite } from './pricebook-payload';

interface Args {
  name: string;
  categoryId?: number;
  categories?: number[];
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
  dryRun?: boolean;
  confirmation_token?: string;
}

function fields({ dryRun: _d, confirmation_token: _t, ...rest }: Args) {
  return rest;
}

export const st_create_service = defineWriteTool<Args>({
  name: 'st_create_service',
  description:
    'Create a new ServiceTitan pricebook service. ' +
    'dryRun=true (default) returns a confirmation_token; call again with dryRun=false + token to write. ' +
    'Pricing mode follows useStaticPrices: when false, ServiceTitan computes price at invoice time (dynamic pricing), so do not set price/memberPrice unless useStaticPrices=true. ' +
    'Use useStaticPrices: true at create time if this service needs static pricing — that flag cannot be flipped via PATCH post-create (UI-only). ' +
    'Source: live ST.',
  zodSchema: {
    name: z.string().min(1).describe('Display name for the service'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID (single-cat shortcut; pass categories[] for multi-cat)'),
    categories: z.array(z.number().int().positive()).min(1).optional().describe('Multi-category. If passed, takes precedence over categoryId.'),
    code: z.string().optional().describe('Service code (e.g. "HVAC-DIAG-01")'),
    description: z.string().optional().describe('Service description shown on invoices'),
    cost: z.number().optional().describe('Internal cost'),
    price: z.number().optional().describe('Static price. Only meaningful when useStaticPrices=true.'),
    memberPrice: z.number().optional().describe('Member-tier static price. Only meaningful when useStaticPrices=true. Omit (or set equal to price) for no member discount.'),
    useStaticPrices: z.boolean().optional().describe('Plural — the field ST actually accepts. true at create time = static pricing. Cannot be flipped via PATCH post-create (UI-only).'),
    hours: z.number().optional().describe('Labor hours (used for cost calc on isLabor=true services)'),
    isLabor: z.boolean().optional().describe('true = labor line item; false = part/equipment/fee'),
    taxable: z.boolean().optional().describe('Whether the service is taxable'),
    account: z.string().optional().describe('GL account name (e.g. "Revenue")'),
    paysCommission: z.boolean().optional().describe('Whether commission applies on sale'),
    active: z.boolean().optional().describe('Whether active in pricebook (default true)'),
  },
  validate(args) {
    if (args.categoryId === undefined && (!args.categories || args.categories.length === 0)) {
      throw new McpError('validation_error', 'st_create_service requires either categoryId or categories[]');
    }
  },
  endpoint: () => '/pricebook/v2/tenant/000000000/services',
  method: 'POST',
  // The token binds the user-facing shape; the outbound payload is rewritten
  // for ServiceTitan (name to displayName, categoryId to categories[]).
  payload: (args) => toStPricebookPayload(fields(args)),
  businessArgs: (args) => fields(args),
  stEndpointTemplate: '/pricebook/v2/tenant/{tid}/services',
  tokenTtlMs: 5 * 60 * 1000,
  verify: verifyPricebookWrite('services'),
});
