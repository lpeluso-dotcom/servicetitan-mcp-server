// st_patch_material: PATCH a pricebook material by ID.
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
  active?: boolean;
  categoryId?: number;
  unitOfMeasure?: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

function fields({ id: _id, dryRun: _d, confirmation_token: _t, ...rest }: Args) {
  return rest;
}

export const st_patch_material = defineWriteTool<Args>({
  name: 'st_patch_material',
  description:
    'PATCH a ServiceTitan pricebook material by ID. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Send only the fields you want to change. Source: live ST.',
  zodSchema: {
    id: z.number().int().positive().describe('ST pricebook material ID'),
    name: z.string().optional().describe('Display name'),
    code: z.string().optional().describe('Material code'),
    description: z.string().optional().describe('Material description'),
    cost: z.number().optional().describe('Internal cost per unit'),
    price: z.number().optional().describe('Price per unit charged to the customer'),
    active: z.boolean().optional().describe('Whether active in pricebook'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID'),
    unitOfMeasure: z.string().optional().describe('Unit of measure (e.g. "Each", "Box")'),
  },
  validate(args) {
    if (Object.keys(fields(args)).length === 0) {
      throw new McpError('validation_error', 'st_patch_material requires at least one field to update besides id');
    }
  },
  endpoint: ({ id }) => `/pricebook/v2/tenant/000000000/materials/${id}`,
  method: 'PATCH',
  payload: (args) => toStPricebookPayload(fields(args)),
  businessArgs: (args) => ({ id: args.id, ...fields(args) }),
  stEndpointTemplate: '/pricebook/v2/tenant/{tid}/materials/{id}',
  tokenTtlMs: 5 * 60 * 1000,
  verify: verifyPricebookWrite('materials'),
});
