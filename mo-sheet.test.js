// Pins the MO-sheet layout so a COLUMNS edit that would desync the writers from
// the reader (or the live sheet) fails loudly. `node mo-sheet.test.js`.
const assert = require('assert');
const { COLUMNS, COL, buildRow, INFO_DEAL_COL, matchRowIndex, firstEmptyRow } = require('./mo-sheet');

// 59 columns, A..BG — must match the live sheet exactly (rush_fee appended at BG).
assert.strictEqual(COLUMNS.length, 59, 'layout must be 59 columns');
assert.strictEqual(COL.rush_fee, 58, 'rush_fee is appended last (BG)');

// Spot-pin the positions that matter (incl. the quirky slot-4/5 qty/price order).
const expected = {
  deal_id: 0, deal_name: 1, deal_stage: 2, tracking_number: 3, customer_email: 4,
  order_number: 5, product_page: 6, print_background: 7, club: 8, in_hand_date: 12,
  payment_terms: 13, p1_url: 14, p1_price: 18, p3_price: 28, p4_url: 29, p5_sizes: 34,
  p4_qty: 35, p4_price: 36, p5_qty: 37, p5_price: 38, subtotal_quantity: 39, subtotal: 40,
  embroidery: 41, art_setup: 42, total: 46, payment_link: 47, payment_link_2: 48,
  strike_embroidery: 49, strike_art: 50, strike_shipping: 51, orig_price_1: 52,
  orig_price_5: 56, drive_pdf_link: 57,
};
for (const [name, idx] of Object.entries(expected)) assert.strictEqual(COL[name], idx, `COL.${name} must be ${idx}`);
assert.strictEqual(INFO_DEAL_COL, 7, 'Order Info deal_id column is H(7)');

// buildRow places values by name, blanks the rest, and is exactly 58 wide.
const row = buildRow({ deal_id: 'D1', order_number: 'Ord', total: 99, strike_embroidery: '1' });
assert.strictEqual(row.length, 59);
assert.strictEqual(row[0], 'D1');
assert.strictEqual(row[5], 'Ord');
assert.strictEqual(row[46], 99);
assert.strictEqual(row[49], '1');
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
