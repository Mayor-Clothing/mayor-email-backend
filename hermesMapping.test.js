// Runnable check for the HubSpot->render mapping. No framework: `node hermesMapping.test.js`.
const assert = require('assert');
const { dealToRenderPayload, INVOICE_PROPERTIES } = require('./hermesMapping');

const deal = {
  id: 'D123',
  properties: {
    order_number: 'Test Club I',
    dealname: 'PO #1 - Test Club',
    dealstage: '07. Delivered',
    zg_tracking_number: '1Z999',
    print_background: 'https://img.example.com/swatch.png',
    club: 'Test Golf & Country Club',
    c_billing_address: '123 Main St\nAtlanta, GA 30307',
    shippingbilling_address: '',
    ship_date: '2026-07-20',
    zf_delivered_date: '2026-07-25',
    y_payment_link: 'https://nickel.com/a / https://nickel.com/b',
    customer_email: 'a@club.com, b@club.com',
    product_page: 'https://mayorclothing.com/x',
    product_1: 'https://img.example.com/polo.png', // URL => treated as image
    description_1: 'Navy piqué',
    sizes_1: 'S-24 M-16 L-8',
    k_quantity_1: '48',
    n_price_1: '42',
    product_2: 'Custom Cap',
    description_2: 'White',
    l_quantity_2: '12',
    z_price_2: '0',
    za_embroidery: '150',
    zb_art_setup: '-40',           // art credit stays negative
    z_sample_reimbursement: '40',
    custom_main_label: '0',
    shipping_cost: '25',
    payment_terms: 'Due on receipt.',
    unstrike: 'Embroidery, Art Setup',
    rush_fee: '150',
  },
};

const p = dealToRenderPayload(deal, 'invoice');

// Doc type + split payment link
assert.strictEqual(p.type, 'invoice');
assert.strictEqual(p.payment_link, 'https://nickel.com/a');
assert.strictEqual(p.payment_link_2, 'https://nickel.com/b');

// Two line items built; empty slots skipped
assert.strictEqual(p.line_items.length, 2);
// Slot 1: product is a URL => image url set, product name defaulted; desc + sizes now separate
assert.strictEqual(p.line_items[0].url, 'https://img.example.com/polo.png');
assert.strictEqual(p.line_items[0].product, 'Custom Print Polo');
assert.strictEqual(p.line_items[0].description, 'Navy piqué');
assert.strictEqual(p.line_items[0].sizes, 'S-24 M-16 L-8');
assert.strictEqual(p.line_items[0].quantity, 48);
assert.strictEqual(p.line_items[0].price, 42);
assert.strictEqual(p.line_items[0].amount, 2016); // qty*price, must not be blank
// Slot 2: non-URL product kept, no sizes
assert.strictEqual(p.line_items[1].product, 'Custom Cap');
assert.strictEqual(p.line_items[1].url, '');
assert.strictEqual(p.line_items[1].description, 'White');
assert.strictEqual(p.line_items[1].sizes, '');

// In Hand Date (zf_delivered_date) formatted like ship date
assert.strictEqual(p.in_hand_date, 'Saturday, July 25, 2026');

// Fees + cross-outs — emb/art always waived; shipping charged unless Strike lists it.
assert.strictEqual(p.embroidery, 150);
assert.strictEqual(p.strike_embroidery, true);
assert.strictEqual(p.art_setup, -40);
assert.strictEqual(p.strike_art, true);
assert.strictEqual(p.shipping, 25);
assert.strictEqual(p.strike_shipping, false);
assert.strictEqual(p.payment_terms, 'Due on receipt.');
assert.strictEqual(p.sample_reimbursement, '(40.00)');
assert.strictEqual(p.custom_label, null); // 0 => omitted

// Force-recompute sentinels
assert.strictEqual(p.subtotal, 0);
assert.strictEqual(p.total, 0);

// Deals-tab-mirrored fields
assert.strictEqual(p.deal_id, 'D123');
assert.strictEqual(p.deal_name, 'PO #1 - Test Club');
assert.strictEqual(p.deal_stage, '07. Delivered');
assert.strictEqual(p.tracking_number, '1Z999');
assert.strictEqual(p.print_background, 'https://img.example.com/swatch.png');
assert.strictEqual(p.subtotal_quantity, 60); // 48 + 12

// order_confirmation maps to 'confirmation'
assert.strictEqual(dealToRenderPayload(deal, 'order_confirmation').type, 'confirmation');

// Empty deal => empty-but-valid payload, no throw
const empty = dealToRenderPayload({ properties: {} }, 'invoice');
assert.strictEqual(empty.line_items.length, 0);
// Empty "Strike" field => emb/art waived (default), shipping charged.
assert.strictEqual(empty.strike_embroidery, true);
assert.strictEqual(empty.strike_art, true);
assert.strictEqual(empty.strike_shipping, false);
// Listing "shipping" waives shipping; emb/art stay waived regardless.
const uns = dealToRenderPayload({ properties: { unstrike: 'Shipping' } }, 'invoice');
assert.strictEqual(uns.strike_embroidery, true);
assert.strictEqual(uns.strike_art, true);
assert.strictEqual(uns.strike_shipping, true);
// "Embroidery and Art Setup" (no shipping) => emb/art waived, shipping charged.
const andForm = dealToRenderPayload({ properties: { unstrike: 'Embroidery and Art Setup' } }, 'invoice');
assert.strictEqual(andForm.strike_embroidery, true);
assert.strictEqual(andForm.strike_art, true);
assert.strictEqual(andForm.strike_shipping, false);
// Oxford-comma + "and Shipping" => shipping also waived.
const allForm = dealToRenderPayload({ properties: { unstrike: 'Embroidery, Art Setup, and Shipping' } }, 'invoice');
assert.strictEqual(allForm.strike_shipping, true);

// Property list covers all 5 slots of qty + price
assert.ok(INVOICE_PROPERTIES.includes('z_quantity_5'));
assert.ok(INVOICE_PROPERTIES.includes('z_price_5'));
assert.ok(INVOICE_PROPERTIES.includes('dealname'));
assert.ok(INVOICE_PROPERTIES.includes('dealstage'));
assert.ok(INVOICE_PROPERTIES.includes('zg_tracking_number'));
assert.ok(INVOICE_PROPERTIES.includes('print_background'));
assert.ok(INVOICE_PROPERTIES.includes('zf_delivered_date'));
assert.ok(INVOICE_PROPERTIES.includes('rush_fee'));
assert.strictEqual(p.rush_fee, 150);

console.log('hermesMapping.test.js: all assertions passed');
