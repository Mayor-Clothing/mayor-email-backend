// Canonical MO-sheet detail-row layout for the Order Confirmations / Invoices
// tabs (columns A..BF, 58 cells). SINGLE SOURCE OF TRUTH for column order: the
// two writers (mayor-email-backend googleStore.buildDetailRow and mayor-invoice
// index.js appendOrderToSheet) and the reader (mayor-invoice portal.js
// parseSheetRow) all derive column positions from here — a layout change is a
// one-line edit instead of three hand-synced arrays that silently drift (F7).
//
// This file is duplicated verbatim in both repos (like doc-render.js). Keep the
// copies identical.

// HubSpot deal-card order (reordered 2026-08-12; scripts/reorder-sheet-columns.js
// migrated the live data in lockstep). Deal ID/Name/Stage stay first so the upsert
// still keys on deal_id at col A and order_number at col F. Per-item block matches
// the deal card: Product · Mockup · Product Page · Description · Sizes · Quantity ·
// Orig Price · Price. Order-level product_page (legacy fallback) + drive_pdf_link
// trail at the end (not shown on the deal card).
const COLUMNS = [
  'deal_id', 'deal_name', 'deal_stage',
  'tracking_number', 'customer_email', 'order_number', 'club', 'shipping_address',
  'address', 'ship_date', 'in_hand_date', 'print_background',
  'p1_url', 'p1_mockup', 'p1_product_page', 'p1_desc', 'p1_sizes', 'p1_qty', 'orig_price_1', 'p1_price',
  'p2_url', 'p2_mockup', 'p2_product_page', 'p2_desc', 'p2_sizes', 'p2_qty', 'orig_price_2', 'p2_price',
  'p3_url', 'p3_mockup', 'p3_product_page', 'p3_desc', 'p3_sizes', 'p3_qty', 'orig_price_3', 'p3_price',
  'p4_url', 'p4_mockup', 'p4_product_page', 'p4_desc', 'p4_sizes', 'p4_qty', 'orig_price_4', 'p4_price',
  'p5_url', 'p5_mockup', 'p5_product_page', 'p5_desc', 'p5_sizes', 'p5_qty', 'orig_price_5', 'p5_price',
  'subtotal_quantity', 'subtotal', 'embroidery', 'art_setup', 'sample_reimbursement',
  'custom_label', 'rush_fee', 'shipping', 'strike_embroidery', 'strike_art', 'strike_shipping',
  'total', 'payment_terms', 'payment_link', 'payment_link_2',
  'product_page', 'drive_pdf_link',
];

// name -> 0-based column index (for the reader).
const COL = {};
COLUMNS.forEach((n, i) => { COL[n] = i; });

// Build the 58-cell row array from a flat, name-keyed object. Missing/nullish
// keys become '' (blank cell). Column order comes solely from COLUMNS, so the
// callers never hand-position values.
function buildRow(vals) {
  return COLUMNS.map((n) => {
    const v = vals[n];
    return v == null ? '' : v;
  });
}

// deal_id lives in a different column per tab: A(0) on Order Confirmations /
// Invoices, H(7) on Order Info (an otherwise-unused column). order_number is
// F(5) on OC/Invoices, A(0) on Order Info.
const INFO_DEAL_COL = 7;

// Pure upsert key: find the row (0-based array index, header at 0) to write into.
// Prefer a STABLE deal_id match so renaming an order in HubSpot updates the
// existing row instead of forking a new one and orphaning the old (F10). If no
// deal_id match, adopt a legacy row with the same order_number and no deal_id
// (e.g. a manual-generator row Hermes is taking over). With no deal_id at all,
// key on order_number. Returns -1 if none. Shared by both writers + tested.
function matchRowIndex(rows, dealIdx, orderIdx, dealId, orderNumber) {
  if (dealId) {
    for (let i = 1; i < rows.length; i++) if (String((rows[i] || [])[dealIdx] || '') === String(dealId)) return i;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!String(r[dealIdx] || '') && String(r[orderIdx] || '') === String(orderNumber)) return i;
    }
    return -1;
  }
  for (let i = 1; i < rows.length; i++) if (String((rows[i] || [])[orderIdx] || '') === String(orderNumber)) return i;
  return -1;
}

// First unused row (1-based) — a row is "used" iff its order_number cell is set.
function firstEmptyRow(rows, orderIdx) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[orderIdx] || String(r[orderIdx]).trim() === '') return i + 1;
  }
  return rows.length + 1;
}

module.exports = { COLUMNS, COL, buildRow, INFO_DEAL_COL, matchRowIndex, firstEmptyRow };
