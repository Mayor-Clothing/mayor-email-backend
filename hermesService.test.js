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
  assert.strictEqual(await syncDealTotals('D1', { properties: {} }, payload, set), true);
  assert.deepStrictEqual(calls[0], ['D1', { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '292.5' }]);
  // Already current (HubSpot hands numbers back as strings) => no write at all.
  assert.strictEqual(await syncDealTotals('D1', { properties: { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '292.50' } }, payload, set), false);
  assert.strictEqual(calls.length, 1);
  // Only the stale one is sent.
  await syncDealTotals('D1', { properties: { u_subtotal_quantity: '5', v_subtotal_price: '250', w_total: '100' } }, payload, set);
  assert.deepStrictEqual(calls[1], ['D1', { w_total: '292.5' }]);
  // A HubSpot failure is swallowed (document generation must not fail).
  assert.strictEqual(await syncDealTotals('D1', { properties: {} }, payload, async () => { throw new Error('403'); }), false);
  console.log('hermesService.test.js: all assertions passed');
})();
