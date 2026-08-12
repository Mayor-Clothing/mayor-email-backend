// Drive + MO-sheet persistence for Hermes.
//
// Writes to the SAME Google Sheet the live orders portal (mayor-invoice/portal.js)
// reads, and uploads the rendered PDF to Drive (newest-only). Guarded: with no
// GOOGLE_SERVICE_ACCOUNT_JSON it no-ops and reports { persisted:false } so the
// /hermes/generate endpoint still works before the service account is set up.
//
// ponytail: the 53-column detail-row layout below is duplicated from
// mayor-invoice (appendOrderToSheet + portal.js parseSheetRow). If that layout
// changes there, update it here too. The clean fix is a shared `mo-sheet.js`
// module (like doc-render.js); not worth it until the schema actually churns.

const { google } = require('googleapis');
const { Readable } = require('stream');
const { buildRow, INFO_DEAL_COL, matchRowIndex, firstEmptyRow } = require('./mo-sheet');

// No fallback: the old hardcoded id ('152hyxQz…') is the DEAD pre-reorg sheet.
// A missing MO_SHEET_ID must fail loudly (see getClients), never silently write
// to the wrong sheet. Only the live id belongs here, and only via the env var.
const SHEET_ID = process.env.MO_SHEET_ID || '';
const DRIVE_FOLDER_ID = process.env.DRIVE_BRAIN_FOLDER_ID || '';
const SHEET_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT || '{}');

// Neutralize spreadsheet formula injection: a value starting with = + - @ (or a
// leading control char) is prefixed with a single quote so Sheets treats it as text.
function sheetSafe(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function credsPresent() {
  return !!SHEET_CREDS.client_email;
}

// Order status is monotonic — automated writes (invoice regen, tracking, delivered,
// paid, and the hourly poll) must only move it FORWARD. Without this, regenerating
// an invoice for an already-paid/delivered order silently resets it to Awaiting
// Payment. Rank blank/unknown as 0 so a first write always lands.
const STATUS_RANK = {
  'awaiting customer approval': 1, 'awaiting payment': 2, 'pending': 3, 'paid': 3,
  'in transit': 4, 'shipped': 4, 'delivered': 5,
};
const statusRank = (s) => STATUS_RANK[String(s || '').trim().toLowerCase()] || 0;

function getClients() {
  if (!SHEET_ID) throw new Error('MO_SHEET_ID is not set — refusing to run against the dead fallback sheet.');
  // Service accounts have no Drive storage quota, so acting as the SA's own
  // identity can't create files ("Service Accounts do not have storage quota").
  // Impersonate the Workspace user (same domain-wide delegation the Gmail client
  // uses) so Drive/Sheets act as mayor@, who has quota and owns the brain folder.
  const auth = new google.auth.JWT({
    email: SHEET_CREDS.client_email,
    key: SHEET_CREDS.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
    subject: process.env.GMAIL_USER || 'mayor@mayorclothing.com',
  });
  return { sheets: google.sheets({ version: 'v4', auth }), drive: google.drive({ version: 'v3', auth }) };
}

// The portal's detail tabs mirror the HubSpot "Deals" tab's column order and
// names exactly (see portal.js parseSheetRow, cols A=0..BF=57), with a few
// fields the Deals tab has no slot for appended at the end (orig_price x5,
// drive_pdf_link) and print_background inserted after product_page. Order
// Number lives at F=5 here, not A — Deal ID takes column A instead. Mirrors
// mayor-invoice appendOrderToSheet's rowData exactly — keep the two in lockstep.
// hermesMapping.js deliberately zeroes payload.subtotal/total ("force doc-render
// to recompute from line items") so the PDF always shows the right numbers even
// when they weren't passed in cleanly. But doc-render.js only computes that
// fallback for its own rendering -- it never hands the number back -- so the
// sheet was being written with blank Subtotal Price/Total on every Hermes-
// generated order. Mirrors doc-render.js's exact fallback formula so the sheet
// gets the same numbers the PDF shows, instead of blanks.
function effectiveSubtotalAndTotal(p) {
  const items = p.line_items || [];
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,()\s]/g, '')); return isNaN(n) ? 0 : n; };
  const artSigned = (v) => {
    const s = String(v == null ? '' : v).trim();
    const magnitude = num(s);
    return (s.startsWith('-') || s.startsWith('(')) ? -Math.abs(magnitude) : magnitude;
  };
  const calcSubtotal = items.reduce((s, i) => s + (parseFloat(String(i.amount).replace(/[$,]/g, '')) || (Number(i.quantity) * Number(i.price)) || 0), 0);
  const subtotal = p.subtotal && Number(p.subtotal) > 0 ? Number(p.subtotal) : calcSubtotal;
  const embForTotal = p.strike_embroidery ? 0 : num(p.embroidery);
  const artForTotal = p.strike_art ? 0 : artSigned(p.art_setup);
  const shipForTotal = p.strike_shipping ? 0 : num(p.shipping);
  const reimbForTotal = num(p.sample_reimbursement);
  const customForTotal = num(p.custom_label);
  const rushForTotal = num(p.rush_fee);
  const total = p.total && Number(p.total) > 0
    ? Number(p.total)
    : subtotal + shipForTotal + customForTotal + rushForTotal + embForTotal + artForTotal - reimbForTotal;
  return { subtotal, total };
}

function buildDetailRow(p, driveLink) {
  const items = p.line_items || [];
  const get = (i, key) => (items[i] ? (items[i][key] || '') : '');
  const subtotalQty = p.subtotal_quantity != null ? p.subtotal_quantity : items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
  const { subtotal: effSubtotal, total: effTotal } = effectiveSubtotalAndTotal(p);
  // Column order lives in mo-sheet.js — reference cells by name, never position.
  return buildRow({
    deal_id: p.deal_id || '', deal_name: p.deal_name || '', deal_stage: p.deal_stage || '', tracking_number: p.tracking_number || '',
    customer_email: p.customer_email || '', order_number: p.order_number || '', product_page: p.product_page || '',
    print_background: p.print_background || '',
    club: p.club || '', shipping_address: p.shipping_address || '', address: p.address || '',
    ship_date: p.ship_date || '', in_hand_date: p.in_hand_date || '', payment_terms: p.payment_terms || '',
    p1_url: get(0, 'url'), p1_desc: get(0, 'description'), p1_sizes: get(0, 'sizes'), p1_qty: get(0, 'quantity'), p1_price: get(0, 'price'),
    p2_url: get(1, 'url'), p2_desc: get(1, 'description'), p2_sizes: get(1, 'sizes'), p2_qty: get(1, 'quantity'), p2_price: get(1, 'price'),
    p3_url: get(2, 'url'), p3_desc: get(2, 'description'), p3_sizes: get(2, 'sizes'), p3_qty: get(2, 'quantity'), p3_price: get(2, 'price'),
    p4_url: get(3, 'url'), p4_desc: get(3, 'description'), p4_sizes: get(3, 'sizes'),
    p5_url: get(4, 'url'), p5_desc: get(4, 'description'), p5_sizes: get(4, 'sizes'),
    p4_qty: get(3, 'quantity'), p4_price: get(3, 'price'), p5_qty: get(4, 'quantity'), p5_price: get(4, 'price'),
    subtotal_quantity: subtotalQty || '', subtotal: effSubtotal || '',
    embroidery: p.embroidery || '',
    art_setup: (p.art_setup != null ? parseFloat(String(p.art_setup).replace(/[$,\s]/g, '')) || '' : ''),
    sample_reimbursement: p.sample_reimbursement || '', custom_label: p.custom_label || '', shipping: p.shipping || '', total: effTotal || '',
    payment_link: p.payment_link || '', payment_link_2: p.payment_link_2 || '',
    strike_embroidery: p.strike_embroidery ? '1' : '', strike_art: p.strike_art ? '1' : '', strike_shipping: p.strike_shipping ? '1' : '',
    orig_price_1: get(0, 'orig_price') || '', orig_price_2: get(1, 'orig_price') || '', orig_price_3: get(2, 'orig_price') || '', orig_price_4: get(3, 'orig_price') || '', orig_price_5: get(4, 'orig_price') || '',
    drive_pdf_link: driveLink || '',
    rush_fee: p.rush_fee || '',
    p1_product_page: get(0, 'product_page'), p2_product_page: get(1, 'product_page'), p3_product_page: get(2, 'product_page'), p4_product_page: get(3, 'product_page'), p5_product_page: get(4, 'product_page'),
    p1_mockup: get(0, 'mockup'), p2_mockup: get(1, 'mockup'), p3_mockup: get(2, 'mockup'), p4_mockup: get(3, 'mockup'), p5_mockup: get(4, 'mockup'),
  });
}

// Pre-registers a customer in the Users sheet (A=email, B=passwordHash, C=club)
// the moment their order is created, so they can log into the portal (via
// "create account", which just sets a password on this row) without needing
// someone to notice and backfill it by hand later. Mirrors mayor-invoice's own
// upsertUserEmail (index.js) -- that one only runs for orders generated through
// mayor-invoice's manual /generate endpoint, not the automated Hermes/HubSpot path.
async function upsertUserEmail(sheets, email, club) {
  if (!email) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:C' });
    const rows = res.data.values || [];
    const idx = rows.findIndex((r) => r[0] && r[0].toLowerCase() === email.toLowerCase());
    if (idx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: 'Users!A:C', valueInputOption: 'USER_ENTERED',
        resource: { values: [[email, '', club || ''].map(sheetSafe)] },
      });
    } else if (!rows[idx][2] && club) {
      // Existing user row but missing club — fill it in
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `Users!C${idx + 1}`,
        valueInputOption: 'USER_ENTERED', resource: { values: [[club]] },
      });
    }
  } catch (e) {
    console.error('upsertUserEmail failed:', e.message);
  }
}

// Upsert a full row, keyed on deal_id (fallback order_number). Returns 1-based row.
async function writeRow(sheets, tab, { dealId, orderNumber }, rowData) {
  const isInfo = tab === 'Order Info';
  const dealIdx = isInfo ? INFO_DEAL_COL : 0;
  const orderIdx = isInfo ? 0 : 5;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:H` });
  const rows = res.data.values || [];
  const idx = matchRowIndex(rows, dealIdx, orderIdx, dealId, orderNumber);
  const targetRow = idx > 0 ? idx + 1 : firstEmptyRow(rows, orderIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [rowData.map(sheetSafe)] },
  });
  return targetRow;
}

// Newest-only: overwrite the existing PDF of this name in the folder, else create.
async function uploadPdfToDrive(drive, orderNumber, docType, pdfBuffer) {
  if (!DRIVE_FOLDER_ID) return { fileId: null, pdfUrl: null };
  const name = `${orderNumber} - ${docType === 'invoice' ? 'Invoice' : 'Order Confirmation'}.pdf`;
  const media = { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) };
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${DRIVE_FOLDER_ID}' in parents and trashed = false`;
  const list = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });

  let fileId;
  if (list.data.files && list.data.files.length) {
    fileId = list.data.files[0].id;
    await drive.files.update({ fileId, media });
  } else {
    const created = await drive.files.create({
      requestBody: { name, parents: [DRIVE_FOLDER_ID], mimeType: 'application/pdf' },
      media,
      fields: 'id',
    });
    fileId = created.data.id;
  }
  return { fileId, pdfUrl: `https://drive.google.com/file/d/${fileId}/view` };
}

// Orchestrator. payload = doc-render payload; docType = 'order_confirmation'|'invoice'.
// Returns { persisted, status, driveFileId, pdfUrl } — never throws (logs + degrades).
async function persistOrder({ payload, docType, pdfBuffer }) {
  // Status is the manual HubSpot "Order Status" dropdown now — no longer derived
  // from docType. Default to Awaiting Approval only for a brand-new order whose
  // dropdown hasn't been set yet.
  const status = payload.order_status || 'Awaiting Approval';
  if (!credsPresent()) {
    return { persisted: false, status, driveFileId: null, pdfUrl: null, skipped: 'no google credentials' };
  }
  try {
    const { sheets, drive } = getClients();
    const orderNumber = payload.order_number || '';
    const dealId = payload.deal_id || '';

    const { fileId, pdfUrl } = await uploadPdfToDrive(drive, orderNumber, docType, pdfBuffer);

    // Order Info: the row the portal lists. Keyed on deal_id (col H) so a HubSpot
    // rename updates in place; read A:H for the deal_id + current status (F3).
    const infoRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Info!A:H' });
    const infoRows = infoRes.data.values || [];
    const infoIdx = matchRowIndex(infoRows, INFO_DEAL_COL, 0, dealId, orderNumber);
    if (infoIdx < 1) {
      await writeRow(sheets, 'Order Info', { dealId, orderNumber },
        [orderNumber, payload.club || '', payload.ship_date || '', payload.customer_email || '', status, '', '', dealId].map(sheetSafe));
      // customer_email can be a comma/semicolon list (see portal.js emailInList) --
      // pre-register each address so every recipient can log in, not just the first.
      const emails = String(payload.customer_email || '').split(/[,;]+/).map((e) => e.trim()).filter(Boolean);
      for (const email of emails) await upsertUserEmail(sheets, email, payload.club);
    } else {
      const row = infoRows[infoIdx];
      const targetRow = infoIdx + 1;
      const updates = [];
      // Rename / legacy-adopt: keep order_number (A) and deal_id (H) current.
      if (String(row[0] || '') !== String(orderNumber)) updates.push({ range: `Order Info!A${targetRow}`, values: [[sheetSafe(orderNumber)]] });
      if (dealId && String(row[INFO_DEAL_COL] || '') !== String(dealId)) updates.push({ range: `Order Info!H${targetRow}`, values: [[sheetSafe(dealId)]] });
      // Manual dropdown status is authoritative — write it whenever it's set and
      // differs (any direction, so Matt can correct it). A blank dropdown leaves
      // whatever's already on the sheet untouched.
      if (payload.order_status && String(row[4] || '') !== payload.order_status) {
        updates.push({ range: `Order Info!E${targetRow}`, values: [[sheetSafe(payload.order_status)]] });
      }
      if (updates.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, resource: { valueInputOption: 'USER_ENTERED', data: updates } });
    }

    // Detail row for the portal's document view — also keyed on deal_id (F10).
    const tab = docType === 'invoice' ? 'Invoices' : 'Order Confirmations';
    await writeRow(sheets, tab, { dealId, orderNumber }, buildDetailRow(payload, pdfUrl));

    return { persisted: true, status, driveFileId: fileId, pdfUrl };
  } catch (e) {
    console.error('persistOrder failed:', e.message);
    return { persisted: false, status, driveFileId: null, pdfUrl: null, error: e.message };
  }
}

// Status-only transition on the Order Info row (portal reads E=status, F=tracking,
// G=delivered). Used by the tracking/delivered triggers. No-op without creds or if
// the order row doesn't exist yet. Returns { updated, status }.
async function setOrderStatus({ orderNumber, status, tracking, deliveredDate }) {
  if (!credsPresent()) return { updated: false, status, skipped: 'no google credentials' };
  try {
    const { sheets } = getClients();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Info!A:E' });
    const col = res.data.values || [];
    // Trim/collapse whitespace on both sides — a Nickel order ref (or a stray
    // sheet cell) with extra spaces must still match its order row.
    const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ');
    const idx = col.findIndex((r, i) => i > 0 && norm(r[0]) === norm(orderNumber));
    if (idx < 1) return { updated: false, status, skipped: 'order not found' };
    const row = idx + 1;

    // Status is monotonic — only write E if it moves forward (F3). Tracking number
    // and delivered date are data, not status, so they always write.
    const data = [];
    if (statusRank(status) > statusRank(col[idx][4])) data.push({ range: `Order Info!E${row}`, values: [[sheetSafe(status)]] });
    if (tracking != null && tracking !== '') data.push({ range: `Order Info!F${row}`, values: [[sheetSafe(tracking)]] });
    if (deliveredDate != null && deliveredDate !== '') data.push({ range: `Order Info!G${row}`, values: [[sheetSafe(deliveredDate)]] });
    if (data.length === 0) return { updated: false, status, skipped: 'no forward change' };

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    });
    return { updated: true, status };
  } catch (e) {
    console.error('setOrderStatus failed:', e.message);
    return { updated: false, status, error: e.message };
  }
}

// Which detail tabs already hold a row for this deal (by deal_id, fallback
// order_number)? Used by the refresh reconcile to update only docs that already
// exist — never materialize a premature OC/Invoice for a deal that was merely
// edited mid-stage. deal_id is col A(0), order_number col F(5) on both tabs.
async function dealDocPresence({ dealId, orderNumber }) {
  if (!credsPresent()) return { oc: false, invoice: false };
  const { sheets } = getClients();
  const has = async (tab) => {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:F` });
    return matchRowIndex(res.data.values || [], 0, 5, dealId, orderNumber) >= 1;
  };
  return { oc: await has('Order Confirmations'), invoice: await has('Invoices') };
}

module.exports = { persistOrder, setOrderStatus, buildDetailRow, credsPresent, matchRowIndex, dealDocPresence };
