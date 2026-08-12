// Pins the MO-sheet layout so a COLUMNS edit that would desync the writers from
// the reader (or the live sheet) fails loudly. `node mo-sheet.test.js`.
const assert = require('assert');
const { COLUMNS, COL, buildRow, INFO_DEAL_COL, matchRowIndex, firstEmptyRow } = require('./mo-sheet');

// 69 columns in HubSpot deal-card order. deal_id at A(0) + order_number at F(5)
// preserved so the upsert keying still works; per-item blocks + totals follow.
assert.strictEqual(COLUMNS.length, 69, 'layout must be 69 columns');

// Spot-pin positions across the new order (bookkeeping front, per-item blocks,
// totals, legacy product_page + drive_pdf_link trailing).
const expected = {
  deal_id: 0, deal_name: 1, deal_stage: 2, tracking_number: 3, customer_email: 4,
  order_number: 5, club: 6, shipping_address: 7, address: 8, ship_date: 9,
  in_hand_date: 10, print_background: 11,
  p1_url: 12, p1_mockup: 13, p1_product_page: 14, p1_desc: 15, p1_sizes: 16, p1_qty: 17, orig_price_1: 18, p1_price: 19,
  p5_url: 44, p5_mockup: 45, orig_price_5: 50, p5_price: 51,
  subtotal_quantity: 52, subtotal: 53, embroidery: 54, art_setup: 55, sample_reimbursement: 56,
  custom_label: 57, rush_fee: 58, shipping: 59, strike_embroidery: 60, strike_art: 61, strike_shipping: 62,
  total: 63, payment_terms: 64, payment_link: 65, payment_link_2: 66, product_page: 67, drive_pdf_link: 68,
};
for (const [name, idx] of Object.entries(expected)) assert.strictEqual(COL[name], idx, `COL.${name} must be ${idx}`);
assert.strictEqual(INFO_DEAL_COL, 7, 'Order Info deal_id column is H(7)');

// buildRow places values by name, blanks the rest, and is exactly 58 wide.
const row = buildRow({ deal_id: 'D1', order_number: 'Ord', total: 99, strike_embroidery: '1' });
assert.strictEqual(row.length, 69);
assert.strictEqual(row[0], 'D1');
assert.strictEqual(row[5], 'Ord');
assert.strictEqual(row[63], 99);
assert.strictEqual(row[60], '1');
assert.strictEqual(row[1], '', 'unset cells blank, not undefined');

// matchRowIndex: OC/Invoices (deal_id A=0, order# F=5).
const oc = [new Array(8).fill('h'), ['D1', '', '', '', '', 'Old', '', ''], ['', '', '', '', '', 'Manual', '', '']];
assert.strictEqual(matchRowIndex(oc, 0, 5, 'D1', 'New'), 1, 'rename: match by deal_id');
assert.strictEqual(matchRowIndex(oc, 0, 5, 'D2', 'Manual'), 2, 'adopt legacy no-deal_id row');
assert.strictEqual(matchRowIndex(oc, 0, 5, '', 'Manual'), 2, 'no deal_id: match order#');
assert.strictEqual(matchRowIndex(oc, 0, 5, 'Dx', 'Nope'), -1);
// Order Info (deal_id H=7, order# A=0).
const info = [new Array(8).fill('h'), ['Old', 'c', '', '', 'Awaiting Payment', '', '', 'D1']];
assert.strictEqual(matchRowIndex(info, INFO_DEAL_COL, 0, 'D1', 'New'), 1, 'Order Info rename by deal_id H');
assert.strictEqual(firstEmptyRow(oc, 5), 4, 'first unused row is one past the last used');

console.log('mo-sheet.test.js: all assertions passed');
