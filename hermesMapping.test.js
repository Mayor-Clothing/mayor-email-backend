// Runnable check for the HubSpot->render mapping. No framework: `node hermesMapping.test.js`.
const assert = require('assert');
const { dealToRenderPayload, INVOICE_PROPERTIES, statusToLabel, statusToValue } = require('./hermesMapping');

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

// Fees + cross-outs. Strike flags come from yes/no checkboxes; when a deal hasn't
// set them the defaults hold (emb/art struck, shipping charged). This deal sets
// no strike_* booleans.
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
// The legacy free-text `unstrike` field is no longer read at all: only the
// checkboxes decide, so text mentioning shipping leaves shipping charged.
const uns = dealToRenderPayload({ properties: { unstrike: 'Shipping' } }, 'invoice');
assert.strictEqual(uns.strike_embroidery, true, 'embroidery default still comped');
assert.strictEqual(uns.strike_art, true, 'art default still comped');
assert.strictEqual(uns.strike_shipping, false, 'unstrike text is inert now');
const allForm = dealToRenderPayload({ properties: { unstrike: 'Embroidery, Art Setup, and Shipping' } }, 'invoice');
assert.strictEqual(allForm.strike_shipping, false, 'no wording of unstrike can strike shipping');

// Explicit yes/no strike checkboxes override the defaults so the total updates.
const boolStrike = dealToRenderPayload({ properties: { strike_embroidery: 'false', strike_art: 'false', strike_shipping: 'true' } }, 'invoice');
assert.strictEqual(boolStrike.strike_embroidery, false, 'checkbox No => embroidery charged');
assert.strictEqual(boolStrike.strike_art, false, 'checkbox No => art charged');
assert.strictEqual(boolStrike.strike_shipping, true, 'checkbox Yes => shipping struck');
const shipFalse = dealToRenderPayload({ properties: { strike_shipping: 'false', unstrike: 'Shipping' } }, 'invoice');
assert.strictEqual(shipFalse.strike_shipping, false, 'checkbox No keeps shipping charged');
const shipTrue = dealToRenderPayload({ properties: { strike_shipping: 'true' } }, 'invoice');
assert.strictEqual(shipTrue.strike_shipping, true, 'checkbox Yes is the only way to strike shipping');
assert.ok(!INVOICE_PROPERTIES.includes('unstrike'), 'unstrike is no longer requested from HubSpot');
assert.ok(INVOICE_PROPERTIES.includes('strike_embroidery'));
assert.ok(INVOICE_PROPERTIES.includes('strike_art'));
assert.ok(INVOICE_PROPERTIES.includes('strike_shipping'));

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

// Order Status: HubSpot stores the option VALUE; the sheet/portal show the LABEL.
assert.strictEqual(statusToLabel('Pending'), 'In Progress');
assert.strictEqual(statusToLabel('Shipped'), 'In Transit');
assert.strictEqual(statusToLabel('Awaiting Payment'), 'Awaiting Payment');
assert.strictEqual(statusToValue('In Transit'), 'Shipped', 'write-back uses the VALUE HubSpot accepts');
assert.strictEqual(statusToValue('Delivered'), 'Delivered');
assert.strictEqual(dealToRenderPayload({ properties: { order_status: 'Pending' } }, 'invoice').order_status, 'In Progress');

// Print/Icons (items 1-6) is shown as "Print: <value>"; a field that already
// starts with "Print:" isn't prefixed twice; other description lines unchanged.
const qtyProp = ['k_quantity_1', 'l_quantity_2', 'm_quantity_3', 'z_quantity_4', 'z_quantity_5', 'z_quantity_6'];
for (let n = 1; n <= 6; n++) {
  const deal = dealToRenderPayload({ properties: { ['description_printicons_' + n]: 'Leaf, Oak Tree', ['description_colorway_' + n]: 'Forest Green', [qtyProp[n - 1]]: '3' } }, 'invoice');
  assert.strictEqual(deal.line_items[0].description, 'Print: Leaf, Oak Tree\nColorway: Forest Green', 'item ' + n);
}
const alreadyPrefixed = dealToRenderPayload({ properties: { description_printicons_1: 'print: Hole names', k_quantity_1: '3' } }, 'invoice');
assert.strictEqual(alreadyPrefixed.line_items[0].description, 'print: Hole names', 'not doubled');
const blankPrint = dealToRenderPayload({ properties: { description_colorway_1: 'Sky', k_quantity_1: '3' } }, 'invoice');
assert.strictEqual(blankPrint.line_items[0].description, 'Colorway: Sky', 'blank Print/Icons adds no line');

// Phone formatting in a structured address: Australian numbers (country code 61)
// read "61 (02) 9669 1511"; US numbers keep "(724) 495-3300" and are untouched.
// (With no billing address set, the shipping address collapses into `address`.)
const phoneLine = (raw) => dealToRenderPayload({ properties: { shipping_address_address_1: '1 Test St', shipping_address_phone_number: raw } }, 'invoice').address.split('\n').pop();
assert.strictEqual(phoneLine('+610296691511'), '61 (02) 9669 1511', 'The Lakes: country code + trunk 0');
assert.strictEqual(phoneLine('+61296691511'), '61 (02) 9669 1511', 'no trunk 0');
assert.strictEqual(phoneLine('+61 2 9669 1511 ext 22'), '61 (02) 9669 1511 x22', 'extension kept');
assert.strictEqual(phoneLine('+61412345678'), '61 0412 345 678', 'AU mobile');
assert.strictEqual(phoneLine('+17244953300'), '(724) 495-3300', 'US unchanged');
assert.strictEqual(phoneLine('+16103334444'), '(610) 333-4444', 'US 610 area code is not Australia');
assert.strictEqual(phoneLine('6103334444'), '(610) 333-4444', 'US 10 digits starting 61 is not Australia');
assert.strictEqual(phoneLine('+61123456789'), '+61123456789', 'a 61 number with an unrecognised leading digit passes through');

// Invoice Date (HubSpot date field) -> "September 23, 2026"; blank stays blank so
// the PDF hides the line. A UTC-midnight timestamp must not slip to the day before.
const invDate = (raw) => dealToRenderPayload({ properties: { invoice_date: raw } }, 'invoice').invoice_date;
assert.strictEqual(invDate('2026-09-23'), 'September 23, 2026');
assert.strictEqual(invDate(String(Date.UTC(2026, 8, 23))), 'September 23, 2026', 'timestamp read in UTC');
assert.strictEqual(invDate(''), '');
assert.strictEqual(invDate(undefined), '');
assert.ok(INVOICE_PROPERTIES.includes('invoice_date'));

// Sales Tax (HubSpot number field) -> positive charge; blank/zero => null so the
// PDF and order page hide the row.
const taxOf = (v) => dealToRenderPayload({ properties: { sales_tax: v } }, 'invoice').sales_tax;
assert.strictEqual(taxOf('123.45'), 123.45);
assert.strictEqual(taxOf(''), null);
assert.strictEqual(taxOf('0'), null);
assert.strictEqual(taxOf(undefined), null);
assert.ok(INVOICE_PROPERTIES.includes('sales_tax'));

console.log('hermesMapping.test.js: all assertions passed');
