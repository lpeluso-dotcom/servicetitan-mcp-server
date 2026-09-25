import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const UpdateItemSchema = z
  .object({
    id: z.number().int().optional(),
    skuId: z.number().int().optional(),
    skuType: z.string().optional(),
    skuName: z.string().optional(),
    description: z.string().nullable().optional(),
    quantity: z.number().optional(),
    unitPrice: z.number().optional(),
    totalPrice: z.number().optional(),
    isAddOn: z.boolean().optional(),
    chargeable: z.boolean().optional(),
    allowDiscounts: z.boolean().optional(),
    unitCost: z.number().optional(),
    memo: z.string().nullable().optional(),
    order: z.number().optional(),
    parentItemId: z.number().nullable().optional(),
    itemGroupParentId: z.number().nullable().optional(),
    itemGroupName: z.string().nullable().optional(),
    projectLabels: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface Args {
  templateId: number;
  name?: string;
  internalName?: string;
  summary?: string;
  mode?: 'Dynamic' | 'Static';
  businessUnitId?: number;
  active?: boolean;
  items?: Array<z.infer<typeof UpdateItemSchema>>;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const update_estimate_template = defineWriteTool<Args>({
  name: 'update_estimate_template',
  description:
    'Update an estimate template. Any top-level field omitted is left unchanged. items, when provided, is a ' +
    'FULL-REPLACEMENT array in the exact GET item shape (verbatim, removal-by-omission) — GET the template first, ' +
    'build the survivor list client-side, then PATCH the whole array back; omitting items entirely leaves existing ' +
    'items untouched. ⚠ Passing items:[] (an explicit empty array) REMOVES ALL ITEMS from the template — this is ' +
    'destructive and different from omitting the field. ⚠ Item-level PATCH does NOT advance modifiedOn (the write persists correctly, but the ' +
    'timestamp stays frozen — do not rely on modifiedOn to detect an item-only update). Source: live ST only. ' +
    'dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
    name: z.string().min(1).optional().describe('Template display name'),
    internalName: z.string().optional().describe('Internal-only name (not shown to customers)'),
    summary: z.string().optional().describe('Short summary/description of the template'),
    mode: z.enum(['Dynamic', 'Static']).optional().describe('Pricing mode'),
    businessUnitId: z.number().int().positive().optional().describe('Business unit this template belongs to'),
    active: z.boolean().optional().describe('active:false has the same effect as delete_estimate_template (soft-deactivate); active:true reactivates a deactivated template.'),
    items: z
      .array(UpdateItemSchema)
      .optional()
      .describe(
        'Full-replacement item array in the exact GET item shape (sent verbatim — removal by omission). ' +
          'Omit entirely to leave existing items untouched.',
      ),
  },
  endpoint: ({ templateId }) => `/sales/v2/tenant/000000000/estimate-templates/${templateId}`,
  method: 'PATCH',
  payload: (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.internalName !== undefined) body.internalName = args.internalName;
    if (args.summary !== undefined) body.summary = args.summary;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.businessUnitId !== undefined) body.businessUnitId = args.businessUnitId;
    if (args.active !== undefined) body.active = args.active;
    if (args.items !== undefined) body.items = args.items;
    return body;
  },
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
});
