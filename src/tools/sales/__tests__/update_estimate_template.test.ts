import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { update_estimate_template } from '../update_estimate_template';
import { CTX, makeEnv, noFetch } from './helpers';


const SURVIVOR_ITEM = {
  id: 1001,
  skuId: 100,
  skuType: 'Service',
  skuName: 'HVAC Diagnostic',
  description: 'Full system diagnostic',
  quantity: 1,
  unitPrice: 89,
  totalPrice: 89,
  isAddOn: false,
  chargeable: true,
  allowDiscounts: true,
  unitCost: 40,
  memo: null,
  order: 0,
  parentItemId: null,
  itemGroupParentId: null,
  itemGroupName: null,
  projectLabels: [],
};

describe('update_estimate_template', () => {
  it('is a write tool', () => {
    expect(update_estimate_template.isWrite).toBe(true);
  });

  it('declares the correct stEndpoint coverage descriptor', () => {
    expect(update_estimate_template.stEndpoint).toEqual({
      method: 'PATCH',
      path: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
      source: 'live',
    });
  });

  it('requires templateId', () => {
    const schema = z.object(update_estimate_template.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ templateId: 10 }).success).toBe(true);
  });

  it('documents the modifiedOn-frozen-on-item-PATCH caveat', () => {
    expect(update_estimate_template.description).toMatch(/modifiedOn/);
    expect(update_estimate_template.description).toMatch(/frozen/i);
  });

  it('accepts partial top-level field updates', () => {
    const schema = z.object(update_estimate_template.zodSchema);
    expect(schema.safeParse({ templateId: 10, name: 'Renamed' }).success).toBe(true);
    expect(schema.safeParse({ templateId: 10, active: false }).success).toBe(true);
    expect(schema.safeParse({ templateId: 10, mode: 'Static' }).success).toBe(true);
    expect(schema.safeParse({ templateId: 10, mode: 'Bogus' }).success).toBe(false);
  });

  it('omits items entirely from the payload when not provided', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await update_estimate_template.handler(env, { templateId: 10, name: 'Renamed' }, CTX);
    expect(dry.payload).not.toHaveProperty('items');
    expect(dry.payload).toEqual({ name: 'Renamed' });
  });

  it('sends items as full-replacement verbatim when provided (not merged/rebuilt)', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await update_estimate_template.handler(env, {
      templateId: 10,
      items: [SURVIVOR_ITEM],
    }, CTX);
    expect(dry.payload.items).toEqual([SURVIVOR_ITEM]);
  });

  it('an empty items array is sent verbatim (removes all items)', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await update_estimate_template.handler(env, { templateId: 10, items: [] }, CTX);
    expect(dry.payload.items).toEqual([]);
  });

  it('rejects dryRun=false without a confirmation_token', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      update_estimate_template.handler(env, { templateId: 10, name: 'X', dryRun: false }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('dryRun -> confirm round-trip PATCHes /sales/v2/tenant/000000000/estimate-templates/{id}', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 10, active: false }), { status: 200 }));
    const dry: any = await update_estimate_template.handler(env, { templateId: 10, active: false }, CTX);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();

    const live: any = await update_estimate_template.handler(
      env,
      { templateId: 10, active: false, dryRun: false, confirmation_token: dry.confirmation_token },
      CTX,
    );
    expect(live.dryRun).toBe(false);
    expect(env.ST_TRANSPORT.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = env.ST_TRANSPORT.fetch.mock.calls[0];
    expect(url).toContain('/api/st/write');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/sales/v2/tenant/000000000/estimate-templates/10');
    expect(body.method).toBe('PATCH');
    expect(body.payload).toEqual({ active: false });
  });

  it('dryRun -> confirm round-trip with an items[] replacement sends it verbatim in the live payload', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 10 }), { status: 200 }));
    const args = { templateId: 10, items: [SURVIVOR_ITEM] };
    const dry: any = await update_estimate_template.handler(env, args, CTX);
    const live: any = await update_estimate_template.handler(
      env,
      { ...args, dryRun: false, confirmation_token: dry.confirmation_token },
      CTX,
    );
    expect(live.dryRun).toBe(false);
    const [, init] = env.ST_TRANSPORT.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.payload.items).toEqual([SURVIVOR_ITEM]);
  });

  it('does not claim or perform any D1 refresh (honest doc note, no refresh mechanism)', () => {

    expect(update_estimate_template.description.toLowerCase()).not.toMatch(/refresh(es|ed|ing)? d1|d1 refresh/);
  });
});
