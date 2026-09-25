import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const CreateItemSchema = z.object({
  skuId: z.number().int().positive().describe('Pricebook SKU ID (service/material/equipment ID) this line references.'),
  skuType: z.enum(['Service', 'Material', 'Equipment']).describe('Type of the referenced SKU.'),
  quantity: z.number().positive().describe('Quantity of this line item.'),
  isAddOn: z.boolean().optional().describe('Whether this item is an optional add-on. Default false.'),
  chargeable: z.boolean().optional().describe('Whether this item is billable. Default true.'),
  allowDiscounts: z
    .boolean()
    .optional()
    .describe(
      'Whether discounts apply to this item. Defaults to true when omitted — ' +
        'pass false explicitly to exclude an item from discounting.',
    ),
  memo: z.string().optional().describe('Internal memo for this line item.'),
  order: z.number().int().optional().describe('Display order within the template.'),

});

type CreateItemArgs = z.infer<typeof CreateItemSchema>;

interface Args {
  name: string;
  internalName: string;
  summary?: string;
  mode: 'Dynamic' | 'Static';
  businessUnitId?: number;
  items: CreateItemArgs[];
  dryRun?: boolean;
  confirmation_token?: string;
}

function buildItemPayload(item: CreateItemArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {
    skuId: item.skuId,
    skuType: item.skuType,
    quantity: item.quantity,
    isAddOn: item.isAddOn ?? false,
    chargeable: item.chargeable ?? true,

    allowDiscounts: item.allowDiscounts ?? true,
  };
  if (item.memo !== undefined) out.memo = item.memo;
  if (item.order !== undefined) out.order = item.order;
  return out;
}

export const create_estimate_template = defineWriteTool<Args>({
  name: 'create_estimate_template',
  description:
    'Create a new estimate template. Item input excludes unitPrice/totalPrice/unitCost/description/skuName — ' +
    "those are ST-computed/denormalized from each item's sku, not caller-supplied. allowDiscounts on an item " +
    'defaults to true when omitted. dryRun=true (default) → token → dryRun=false to write. ' +
    'Source: live ST. Referenced service SKUs must be active; an inactive SKU may be reported as not found. ' +
    'Do not add a model field.',
  zodSchema: {
    name: z.string().min(1).describe('Template display name'),
    internalName: z.string().min(1).describe('Internal-only name (not shown to customers). REQUIRED by ST at create time despite being optional on GET.'),
    summary: z.string().optional().describe('Short summary/description of the template'),
    mode: z.enum(['Dynamic', 'Static']).describe('Pricing mode — Dynamic computes at invoice time; Static uses fixed prices'),
    businessUnitId: z.number().int().positive().optional().describe('Business unit this template belongs to'),
    items: z.array(CreateItemSchema).describe('Line items to include in the template'),
  },
  endpoint: () => `/sales/v2/tenant/000000000/estimate-templates`,
  method: 'POST',
  payload: (args) => {
    const body: Record<string, unknown> = {
      name: args.name,
      internalName: args.internalName,
      mode: args.mode,
      items: args.items.map(buildItemPayload),
    };
    if (args.summary !== undefined) body.summary = args.summary;
    if (args.businessUnitId !== undefined) body.businessUnitId = args.businessUnitId;
    return body;
  },
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates',
});
