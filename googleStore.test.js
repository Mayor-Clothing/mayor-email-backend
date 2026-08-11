// Runnable check for the MO-sheet row layout + no-creds guard.
// `node googleStore.test.js`. No network: persistOrder must no-op without creds.
const assert = require('assert');
const { buildDetailRow, persistOrder, credsPresent, matchRowIndex } = require('./googleStore');

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

// Deals-tab-mirrored layout (see portal.js parseSheetRow, A=0..BF=57).
assert.strictEqual(row[0], 'D123');                  // A  deal_id
assert.strictEqual(row[1], 'PO #1 - Test');          // B  deal_name
assert.strictEqual(row[2], 'Delivered');             // C  deal_stage
assert.strictEqual(row[3], '1Z999');                 // D  tracking_number
assert.strictEqual(row[4], 'a@club.com');            // E  customer_email
assert.strictEqual(row[5], 'Test Club I');           // F  order_number
assert.strictEqual(row[6], 'https://x');             // G  product_page
assert.strictEqual(row[7], 'https://img/bg.png');    // H  print_background
assert.strictEqual(row[8], 'Test GCC');              // I  club
assert.strictEqual(row[9], '');                      // J  shipping_address
assert.strictEqual(row[10], '123 Main St');          // K  address
assert.strictEqual(row[11], '2026-07-20');           // L  ship_date
assert.strictEqual(row[12], '2026-08-01');           // M  in_hand_date
assert.strictEqual(row[13], 'Net 30');               // N  payment_terms
assert.strictEqual(row[14], 'https://img/p.png');    // O  product_1 (url)
assert.strictEqual(row[15], 'Navy');                 // P  description_1
assert.strictEqual(row[16], 'S-24 M-16 L-8');        // Q  sizes_1
assert.strictEqual(row[17], 48);                     // R  quantity_1
assert.strictEqual(row[18], 42);                     // S  price_1
assert.strictEqual(row[20], 'White');                // U  description_2
assert.strictEqual(row[21], '');                     // V  sizes_2
assert.strictEqual(row[39], 60);                     // AN subtotal_quantity
assert.strictEqual(row[40], 2016);                   // AO subtotal_price
assert.strictEqual(row[41], 150);                    // AP embroidery
assert.strictEqual(row[42], -40);                    // AQ art_setup (signed)
assert.strictEqual(row[43], '(40.00)');              // AR sample_reimbursement
assert.strictEqual(row[45], 25);                     // AT shipping
assert.strictEqual(row[46], 2276);                   // AU total
assert.strictEqual(row[47], 'https://nickel.com/a'); // AV payment_link
assert.strictEqual(row[48], 'https://nickel.com/b'); // AW payment_link_2
assert.strictEqual(row[49], '1');                    // AX strike_embroidery
assert.strictEqual(row[50], '');                     // AY strike_art (false)
assert.strictEqual(row[51], '1');                    // AZ strike_shipping
assert.strictEqual(row[57], 'https://drive.google.com/file/d/abc/view'); // BF drive_pdf_link
assert.strictEqual(row[59], 'https://x/details1');  // BH p1_product_page (per-item link)
assert.strictEqual(row[64], 'https://img/mock1.png'); // BM p1_mockup
assert.strictEqual(row.length, 69);

// hermesMapping.js deliberately sends subtotal:0/total:0 ("force doc-render to
// recompute from line items") -- buildDetailRow must fall back to the same
// computed numbers doc-render.js's PDF shows, not write blanks to the sheet.
const zeroedPayload = { ...payload, subtotal: 0, total: 0 };
const zeroedRow = buildDetailRow(zeroedPayload, 'https://drive.google.com/file/d/abc/view');
assert.strictEqual(zeroedRow[40], 2016, 'subtotal falls back to sum of line items');
assert.strictEqual(zeroedRow[46], 1936, 'total falls back to subtotal + shipping/custom/emb/art - reimbursement (struck fees excluded)');

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
  const oc = await persistOrder({ payload, docType: 'order_confirmation', pdfBuffer: Buffer.from('x') });
  assert.strictEqual(oc.persisted, false);
  assert.strictEqual(oc.status, 'Awaiting Customer Approval');
  const inv = await persistOrder({ payload, docType: 'invoice', pdfBuffer: Buffer.from('x') });
  assert.strictEqual(inv.status, 'Awaiting Payment');
  console.log('googleStore.test.js: all assertions passed');
})();
