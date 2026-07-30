// Canonical MO-sheet detail-row layout for the Order Confirmations / Invoices
// tabs (columns A..BF, 58 cells). SINGLE SOURCE OF TRUTH for column order: the
// two writers (mayor-email-backend googleStore.buildDetailRow and mayor-invoice
// index.js appendOrderToSheet) and the reader (mayor-invoice portal.js
// parseSheetRow) all derive column positions from here — a layout change is a
// one-line edit instead of three hand-synced arrays that silently drift (F7).
//
// This file is duplicated verbatim in both repos (like doc-render.js). Keep the
// copies identical.

const COLUMNS = [
  'deal_id', 'deal_name', 'deal_stage', 'tracking_number', 'customer_email',
  'order_number', 'product_page', 'print_background', 'club', 'shipping_address',
  'address', 'ship_date', 'in_hand_date', 'payment_terms',
  // Line items x5 — the Deals tab's quirky order: slots 1-3 are
  // url/desc/sizes/qty/price; slots 4-5 group url/desc/sizes, then their
  // qty/price come after slot 5's sizes.
  'p1_url', 'p1_desc', 'p1_sizes', 'p1_qty', 'p1_price',
  'p2_url', 'p2_desc', 'p2_sizes', 'p2_qty', 'p2_price',
  'p3_url', 'p3_desc', 'p3_sizes', 'p3_qty', 'p3_price',
  'p4_url', 'p4_desc', 'p4_sizes',
  'p5_url', 'p5_desc', 'p5_sizes',
  'p4_qty', 'p4_price', 'p5_qty', 'p5_price',
  'subtotal_quantity', 'subtotal', 'embroidery', 'art_setup', 'sample_reimbursement',
  'custom_label', 'shipping', 'total', 'payment_link', 'payment_link_2',
  'strike_embroidery', 'strike_art', 'strike_shipping',
  'orig_price_1', 'orig_price_2', 'orig_price_3', 'orig_price_4', 'orig_price_5',
  'drive_pdf_link',
  // Appended after the original 58 (drive_pdf_link) so existing column positions
  // never shift. Rush Fee (BG) — a deal-level surcharge like Shipping.
  'rush_fee',
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
