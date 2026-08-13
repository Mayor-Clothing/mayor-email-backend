// Maps a HubSpot deal's properties -> the doc-render.js payload (the same shape
// mayor-invoice's /generate consumes). Property names verified against the live
// Mayor account (deals object). Keep this table as the single place to fix names.
//
// New props not yet created in HubSpot (zj_payment_terms, z_crossouts, trigger
// checkboxes) are read defensively: absent => sensible defaults (no strikes,
// default payment terms), so this works before the manual HubSpot config lands.

// Real HubSpot property names, per slot (1..5). The letter prefixes are Matt's
// display-sort convention, not multiple values — one qty + one price per slot.
const { formatAddrHS, parseShipDate, cleanDescription, qtyFromSizes } = require('./hubspotFormat');

const QTY_PROPS   = ['k_quantity_1', 'l_quantity_2', 'm_quantity_3', 'z_quantity_4', 'z_quantity_5'];
const PRICE_PROPS = ['n_price_1', 'z_price_2', 'z_price_3', 'z_price_4', 'z_price_5'];
const ORIG_PRICE_PROPS = ['orig_price_1', 'orig_price_2', 'orig_price_3', 'orig_price_4', 'orig_price_5'];
const PRODUCT_PAGE_PROPS = ['product_page_1', 'product_page_2', 'product_page_3', 'product_page_4', 'product_page_5'];
const MOCKUP_PROPS = ['mockup_1', 'mockup_2', 'mockup_3', 'mockup_4', 'mockup_5'];

// HubSpot's Order Status dropdown stores an internal VALUE; Matt renamed two
// option labels (Pending -> "In Progress", Shipped -> "In Transit") but kept the
// old values. Everything human-facing (sheet, portal, HubSpot UI) shows the
// LABEL; HubSpot's API reads/writes the VALUE. Map both ways — update if the
// dropdown options ever change again.
const STATUS_VALUE_TO_LABEL = { Pending: 'In Progress', Shipped: 'In Transit', 'Awaiting Approval': 'Awaiting Customer Approval' };
const STATUS_LABEL_TO_VALUE = { 'In Progress': 'Pending', 'In Transit': 'Shipped', 'Awaiting Customer Approval': 'Awaiting Approval' };
const statusToLabel = (v) => { const s = String(v == null ? '' : v).trim(); return STATUS_VALUE_TO_LABEL[s] || s; };
const statusToValue = (l) => { const s = String(l == null ? '' : l).trim(); return STATUS_LABEL_TO_VALUE[s] || s; };

// Every deal property Hermes needs to render a document. Request exactly these.
const INVOICE_PROPERTIES = [
  'order_number', 'club', 'c_billing_address', 'shippingbilling_address', 'ship_date',
  'y_payment_link', 'customer_email', 'product_page',
  'product_1', 'product_2', 'product_3', 'product_4', 'product_5',
  'description_1', 'description_2', 'description_3', 'description_4', 'description_5',
  'sizes_1', 'sizes_2', 'sizes_3', 'sizes_4', 'sizes_5',
  ...QTY_PROPS, ...PRICE_PROPS, ...ORIG_PRICE_PROPS, ...PRODUCT_PAGE_PROPS, ...MOCKUP_PROPS,
  'za_embroidery', 'zb_art_setup', 'z_sample_reimbursement', 'custom_main_label', 'shipping_cost',
  'rush_fee', 'payment_terms', 'unstrike', 'strike_embroidery', 'strike_art', 'strike_shipping', 'zf_delivered_date',
  // Deals-tab-mirrored sheet columns (dealname/dealstage are standard HubSpot
  // properties; zg_tracking_number is Matt's tracking-number field, also used
  // as the "in transit" trigger elsewhere; print_background is Matt's print
  // swatch/background image property).
  'dealname', 'dealstage', 'order_status', 'zg_tracking_number', 'print_background',
];

// parseFloat that tolerates "$", "," and stray spaces; preserves a leading minus.
function n(v) {
  const parsed = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(parsed) ? 0 : parsed;
}

// docType from the trigger -> doc-render's `type`.
function docTypeToType(docType) {
  return docType === 'invoice' ? 'invoice' : 'confirmation';
}

// deal = HubSpot deal object ({ properties: {...} }); docType = 'order_confirmation'|'invoice'.
function dealToRenderPayload(deal, docType) {
  const p = deal?.properties || {};

  // Line items: mirror the invoice-generator tab's build (product-as-URL -> image).
  const line_items = [];
  for (let i = 0; i < 5; i++) {
    const desc = cleanDescription((p['description_' + (i + 1)] || '').trim());
    const sizes = (p['sizes_' + (i + 1)] || '').trim();
    let qty = n(p[QTY_PROPS[i]]);
    if (!qty && sizes) qty = qtyFromSizes(sizes);  // auto-qty from sizes (original rule)
    if (!qty && !desc) continue;

    const rawProduct = (p['product_' + (i + 1)] || '').trim();
    const isUrl = /^https?:\/\//i.test(rawProduct);
    const price = n(p[PRICE_PROPS[i]]);

    line_items.push({
      product: isUrl ? 'Custom Print Polo' : (rawProduct || 'Custom Print Polo'),
      url: isUrl ? rawProduct : '',
      // The typed-in name, empty when the slot holds an image URL instead. The
      // sheet's Product N column doubles as name-or-URL (portal.html nameLabel),
      // so this is what lands there when there's no image to show.
      product_name: isUrl ? '' : rawProduct,
      description: desc,           // sizes kept separate now (own sheet column + re-merged at render)
      sizes,
      quantity: qty,
      orig_price: n(p[ORIG_PRICE_PROPS[i]]) || null,   // per-slot "was" price (blank => no strike)
      price,
      amount: qty * price,         // doc-render leaves the cell blank if amount is missing
      product_page: (p[PRODUCT_PAGE_PROPS[i]] || '').trim(),   // per-item "Additional Details" link
      mockup: (p[MOCKUP_PROPS[i]] || '').trim(),               // per-item mockup image
    });
  }

  // Payment links: one field, one or two links separated by " / " => 50/50 labeling.
  const links = String(p.y_payment_link || '').split(' / ').map((s) => s.trim()).filter(Boolean);

  // Strike/waive logic — driven by explicit yes/no HubSpot checkboxes
  // (Strike Embroidery / Strike Art / Strike Shipping) so Matt controls which
  // fees are comped per deal and the total updates. Struck => excluded from the
  // total (downstream: doc-render, googleStore effectiveSubtotalAndTotal, portal).
  // Defaults when a deal hasn't set the box preserve the historical convention
  // and keep already-written orders unchanged on regen: Embroidery + Art comped
  // (struck), Shipping charged. Shipping also still honors the legacy free-text
  // `unstrike` ("Strike") field until deals adopt the checkbox.
  const strikeStr = String(p.unstrike || '').toLowerCase();
  const asBool = (v, dflt) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '' ? dflt : (s === 'true' || s === 'yes' || s === '1');
  };
  const strikeEmb = asBool(p.strike_embroidery, true);
  const strikeArt = asBool(p.strike_art, true);
  const strikeShip = (p.strike_shipping != null && String(p.strike_shipping).trim() !== '')
    ? asBool(p.strike_shipping, false)
    : /shipping/.test(strikeStr);

  const emb = n(p.za_embroidery);
  const art = n(p.zb_art_setup);           // signed: negative = art credit
  const label = n(p.custom_main_label);
  const rush = n(p.rush_fee);
  const sampleReimb = n(p.z_sample_reimbursement);

  // Address blocks + ship date — mirror mayor-tools' formatting rules exactly.
  // shippingbilling_address is the primary address; c_billing_address is the
  // separate billing address when present and different.
  const mainAddr = (p.shippingbilling_address || '').trim();
  const billingAddr = (p.c_billing_address || '').trim();
  let addressBlock = mainAddr ? formatAddrHS(mainAddr) : '';
  let shippingBlock = '';
  if (billingAddr && billingAddr !== mainAddr) {
    addressBlock = formatAddrHS(billingAddr);
    shippingBlock = formatAddrHS(mainAddr);
  }

  return {
    type: docTypeToType(docType),
    deal_id: deal?.id || '',
    deal_name: p.dealname || '',
    deal_stage: p.dealstage || '',
    order_status: statusToLabel(p.order_status),   // dropdown VALUE -> display LABEL for the sheet
    tracking_number: p.zg_tracking_number || '',
    print_background: p.print_background || '',
    order_number: p.order_number || '',
    club: p.club || '',
    address: addressBlock,
    shipping_address: shippingBlock,
    ship_date: parseShipDate(p.ship_date || ''),
    in_hand_date: parseShipDate(p.zf_delivered_date || ''),  // HubSpot "In Hand Date" -> sheet col M
    date_label: 'Ship Date',                // delivery date dropped (blueprint §4.3)
    customer_email: p.customer_email || '',
    product_page: p.product_page || '',
    payment_link: links[0] || '',
    payment_link_2: links[1] || '',
    payment_terms: p.payment_terms || '',
    line_items,
    subtotal_quantity: line_items.reduce((s, li) => s + (Number(li.quantity) || 0), 0),
    subtotal: 0,                            // force doc-render to recompute from line items
    total: 0,                               // ditto — line items are the source of truth
    embroidery: emb || null,
    strike_embroidery: strikeEmb,
    art_setup: art !== 0 ? art : null,
    strike_art: strikeArt,
    shipping: n(p.shipping_cost),
    strike_shipping: strikeShip,
    sample_reimbursement: sampleReimb > 0 ? `(${sampleReimb.toFixed(2)})` : null,
    custom_label: label > 0 ? label : null,
    rush_fee: rush > 0 ? rush : null,
  };
}

module.exports = { dealToRenderPayload, INVOICE_PROPERTIES, statusToLabel, statusToValue };
