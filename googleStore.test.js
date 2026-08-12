// Runnable check for the MO-sheet row layout + no-creds guard.
// `node googleStore.test.js`. No network: persistOrder must no-op without creds.
const assert = require('assert');
const { buildDetailRow, persistOrder, credsPresent, matchRowIndex } = require('./googleStore');
const { COL } = require('./mo-sheet');

// Row must place fields at the exact indices portal.js parseSheetRow reads.
const payload = {
  deal_id: 'D123', deal_name: 'PO #1 - Test', deal_stage: 'Delivered', tracking_number: '1Z999',
  order_number: 'Test Club I', customer_email: 'a@club.com', club: 'Test GCC',
  address: '123 Main St', ship_date: '2026-07-20', payment_link: 'https://nickel.com/a',
  print_background: 'https://img/bg.png', in_hand_date: '2026-08-01',
  line_items: [
    { url: 'https://img/p.png', description: 'Navy', sizes: 'S-24 M-16 L-8', quantity: 48, price: 42, orig_price: null, product_page: 'https://x/details1', mockup: 'https://img/mock1.png' },
    { url: '', description: 'White', sizes: '', quantity: 12, price: 0, orig_price: null },
  ],
  shipping: 25, subtotal: 2016, embroidery: 150, art_setup: -40, total: 2276,
  product_page: 'https://x', shipping_address: '',
  payment_link_2: 'https://nickel.com/b', payment_terms: 'Net 30',
  strike_embroidery: true, strike_art: false, strike_shipping: true,
  custom_label: null, sample_reimbursement: '(40.00)',
};

const row = buildDetailRow(payload, 'https://drive.google.com/file/d/abc/view');

// buildDetailRow must place each field at its NAMED column. Positions are pinned
// separately in mo-sheet.test.js, so this stays correct across column reorders.
assert.strictEqual(row[COL.deal_id], 'D123');
assert.strictEqual(row[COL.deal_name], 'PO #1 - Test');
assert.strictEqual(row[COL.deal_stage], 'Delivered');
assert.strictEqual(row[COL.tracking_number], '1Z999');
assert.strictEqual(row[COL.customer_email], 'a@club.com');
assert.strictEqual(row[COL.order_number], 'Test Club I');
assert.strictEqual(row[COL.product_page], 'https://x');
assert.strictEqual(row[COL.print_background], 'https://img/bg.png');
assert.strictEqual(row[COL.club], 'Test GCC');
assert.strictEqual(row[COL.shipping_address], '');
assert.strictEqual(row[COL.address], '123 Main St');
assert.strictEqual(row[COL.ship_date], '2026-07-20');
assert.strictEqual(row[COL.in_hand_date], '2026-08-01');
assert.strictEqual(row[COL.payment_terms], 'Net 30');
assert.strictEqual(row[COL.p1_url], 'https://img/p.png');
assert.strictEqual(row[COL.p1_desc], 'Navy');
assert.strictEqual(row[COL.p1_sizes], 'S-24 M-16 L-8');
assert.strictEqual(row[COL.p1_qty], 48);
assert.strictEqual(row[COL.p1_price], 42);
assert.strictEqual(row[COL.p2_desc], 'White');
assert.strictEqual(row[COL.p2_sizes], '');
assert.strictEqual(row[COL.subtotal_quantity], 60);
assert.strictEqual(row[COL.subtotal], 2016);
assert.strictEqual(row[COL.embroidery], 150);
assert.strictEqual(row[COL.art_setup], -40);
assert.strictEqual(row[COL.sample_reimbursement], '(40.00)');
assert.strictEqual(row[COL.shipping], 25);
assert.strictEqual(row[COL.total], 2276);
assert.strictEqual(row[COL.payment_link], 'https://nickel.com/a');
assert.strictEqual(row[COL.payment_link_2], 'https://nickel.com/b');
assert.strictEqual(row[COL.strike_embroidery], '1');
assert.strictEqual(row[COL.strike_art], '');
assert.strictEqual(row[COL.strike_shipping], '1');
assert.strictEqual(row[COL.drive_pdf_link], 'https://drive.google.com/file/d/abc/view');
assert.strictEqual(row[COL.p1_product_page], 'https://x/details1');
assert.strictEqual(row[COL.p1_mockup], 'https://img/mock1.png');
assert.strictEqual(row.length, 69);

// hermesMapping.js deliberately sends subtotal:0/total:0 ("force doc-render to
// recompute from line items") -- buildDetailRow must fall back to the same
// computed numbers doc-render.js's PDF shows, not write blanks to the sheet.
const zeroedPayload = { ...payload, subtotal: 0, total: 0 };
const zeroedRow = buildDetailRow(zeroedPayload, 'https://drive.google.com/file/d/abc/view');
assert.strictEqual(zeroedRow[COL.subtotal], 2016, 'subtotal falls back to sum of line items');
assert.strictEqual(zeroedRow[COL.total], 1936, 'total falls back to subtotal + shipping/custom/emb/art - reimbursement (struck fees excluded)');

// F10 upsert keying: prefer stable deal_id so a HubSpot rename updates in place.
// OC/Invoices layout: deal_id col A(0), order_number col F(5).
const ocRows = [
  new Array(8).fill('hdr'),
  ['D1', '', '', '', '', 'Old Name', '', ''],   // row 2: deal D1, order "Old Name"
  ['', '', '', '', '', 'Manual', '', ''],        // row 3: legacy row, no deal_id
];
assert.strictEqual(matchRowIndex(ocRows, 0, 5, 'D1', 'New Name'), 1, 'rename: found by deal_id, not order#');
assert.strictEqual(matchRowIndex(ocRows, 0, 5, 'D2', 'Manual'), 2, 'adopt legacy no-deal_id row by order#');
assert.strictEqual(matchRowIndex(ocRows, 0, 5, '', 'Manual'), 2, 'no deal_id: fall back to order#');
assert.strictEqual(matchRowIndex(ocRows, 0, 5, 'D9', 'Nope'), -1, 'no match');
// Order Info layout: deal_id col H(7), order_number col A(0).
const infoRows = [
  new Array(8).fill('hdr'),
  ['Old Name', 'club', '', '', 'Awaiting Payment', '', '', 'D1'],
];
assert.strictEqual(matchRowIndex(infoRows, 7, 0, 'D1', 'New Name'), 1, 'Order Info rename by deal_id in col H');
assert.strictEqual(matchRowIndex(infoRows, 7, 0, '', 'Old Name'), 1, 'Order Info fallback by order#');
assert.strictEqual(matchRowIndex(infoRows, 7, 0, 'D2', 'Nope'), -1, 'Order Info no match');

// No creds => persistOrder degrades gracefully, does not throw, reports status.
(async () => {
  assert.strictEqual(credsPresent(), false, 'test env should have no GOOGLE_SERVICE_ACCOUNT_JSON');
  // Status is manual now: with no order_status set, both docTypes default to
  // Awaiting Customer Approval (invoice no longer auto-advances to Awaiting Payment).
  const oc = await persistOrder({ payload, docType: 'order_confirmation', pdfBuffer: Buffer.from('x') });
  assert.strictEqual(oc.persisted, false);
  assert.strictEqual(oc.status, 'Awaiting Customer Approval');
  const inv = await persistOrder({ payload, docType: 'invoice', pdfBuffer: Buffer.from('x') });
  assert.strictEqual(inv.status, 'Awaiting Customer Approval', 'invoice no longer forces Awaiting Payment');
  // The HubSpot dropdown drives the status verbatim when set.
  const withStatus = await persistOrder({ payload: { ...payload, order_status: 'Delivered' }, docType: 'invoice', pdfBuffer: Buffer.from('x') });
  assert.strictEqual(withStatus.status, 'Delivered');
  console.log('googleStore.test.js: all assertions passed');
})();
