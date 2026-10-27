// Runnable check for the webhook event -> action classifier. `node hermesService.test.js`.
const assert = require('assert');
const { classifyTriggerEvent, TRIGGER } = require('./hermesService');

const pc = (propertyName, propertyValue, objectId = '123') =>
  ({ subscriptionType: 'deal.propertyChange', propertyName, propertyValue, objectId });

// OC trigger: only on true
assert.deepStrictEqual(classifyTriggerEvent(pc(TRIGGER.oc, 'true')), { action: 'generate_oc', dealId: '123' });
assert.deepStrictEqual(classifyTriggerEvent(pc(TRIGGER.oc, true)), { action: 'generate_oc', dealId: '123' });
assert.strictEqual(classifyTriggerEvent(pc(TRIGGER.oc, 'false')), null);

// Invoice trigger
assert.deepStrictEqual(classifyTriggerEvent(pc(TRIGGER.invoice, 'true')), { action: 'generate_invoice', dealId: '123' });

// Tracking: any non-empty value => in_transit
assert.deepStrictEqual(classifyTriggerEvent(pc(TRIGGER.tracking, '1Z999')), { action: 'in_transit', dealId: '123' });
assert.strictEqual(classifyTriggerEvent(pc(TRIGGER.tracking, '')), null);

// Delivered: presence of a date => delivered
assert.deepStrictEqual(classifyTriggerEvent(pc(TRIGGER.delivered, '2026-07-25')), { action: 'delivered', dealId: '123' });
assert.strictEqual(classifyTriggerEvent(pc(TRIGGER.delivered, '')), null);

// Irrelevant events ignored
assert.strictEqual(classifyTriggerEvent(pc('dealstage', 'appointmentscheduled')), null);
assert.strictEqual(classifyTriggerEvent({ subscriptionType: 'deal.creation', objectId: '1' }), null);
assert.strictEqual(classifyTriggerEvent(undefined), null);

// Totals written back to the deal: only what changed, never when already current.
(async () => {
  const { syncDealTotals } = require('./hermesService');
  const payload = { line_items: [{ quantity: 5, price: 50, amount: 250 }], subtotal: 0, total: 0, subtotal_quantity: 5, shipping: 25, sales_tax: 17.5 };
  const calls = [];
  const set = async (id, props) => { calls.push([id, props]); };
  const r1 = await syncDealTotals('D1', { properties: {} }, payload, set);
  assert.deepStrictEqual(r1.written, ['u_subtotal_quantity', 'v_subtotal_price', 'w_total']);
  assert.deepStrictEqual(r1.failed, []);
  assert.deepStrictEqual(calls[0], ['D1', { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '292.5' }]);
  // Already current (HubSpot hands numbers back as strings) => no write at all.
  const r2 = await syncDealTotals('D1', { properties: { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '292.50' } }, payload, set);
  assert.deepStrictEqual(r2, { written: [], failed: [] });
  assert.strictEqual(calls.length, 1);
  // Only the stale one is sent.
  await syncDealTotals('D1', { properties: { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '100' } }, payload, set);
  assert.deepStrictEqual(calls[1], ['D1', { w_total: '292.5' }]);
  // One refused field (HubSpot rejects the whole request) must not block the other two:
  // the retry goes field by field and names the refused one.
  const sent = [];
  const picky = async (id, props) => {
    if ('w_total' in props) throw new Error('HubSpot API error 400 on /crm/v3/objects/deals/D1: {"status":"error","message":"Property \\"w_total\\" is read-only"}');
    sent.push(props);
  };
  const r3 = await syncDealTotals('D1', { properties: {} }, payload, picky);
  assert.deepStrictEqual(r3.written, ['u_subtotal_quantity', 'v_subtotal_price']);
  assert.strictEqual(r3.failed.length, 1);
  assert.strictEqual(r3.failed[0].prop, 'w_total');
  assert.ok(/400/.test(r3.failed[0].error), 'error is summarised with its status');
  // The HubSpot error body nests per-property problems inside an escaped JSON string;
  // the summary must surface the specific reason, not cut off at the first quote.
  const nested = async () => { throw new Error('HubSpot API error 400 on /crm/v3/objects/deals/D1: ' + JSON.stringify({ status: 'error', message: 'Property values were not valid: ' + JSON.stringify([{ isValid: false, message: 'Property "w_total" is read-only', error: 'READ_ONLY_VALUE', name: 'w_total' }]) })); };
  const r5 = await syncDealTotals('D1', { properties: {} }, payload, nested);
  assert.ok(/READ_ONLY_VALUE/.test(r5.failed[0].error) && /read-only/.test(r5.failed[0].error), 'specific reason shown: ' + r5.failed[0].error);
  // A total HubSpot failure is swallowed (document generation must not fail).
  const r4 = await syncDealTotals('D1', { properties: {} }, payload, async () => { throw new Error('403'); });
  assert.strictEqual(r4.written.length, 0);
  assert.strictEqual(r4.failed.length, 3);
  console.log('hermesService.test.js: all assertions passed');
})();
