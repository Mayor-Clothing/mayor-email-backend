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
const { buildRow, INFO_DEAL_COL, INFO_DEALNAME_COL, INFO_PAYMENTSTATUS_COL, matchRowIndex, firstEmptyRow } = require('./mo-sheet');
const { parseShipDate } = require('./hubspotFormat');

// No fallback: the old hardcoded id ('152hyxQz…') is the DEAD pre-reorg sheet.
// A missing MO_SHEET_ID must fail loudly (see getClients), never silently write
// to the wrong sheet. Only the live id belongs here, and only via the env var.
const SHEET_ID = process.env.MO_SHEET_ID || '';
const DRIVE_FOLDER_ID = process.env.DRIVE_BRAIN_FOLDER_ID || '';
const SHEET_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT || '{}');

// Neutralize spreadsheet formula injection: a value starting with = + - @ (or a
// leading control char) is prefixed with a single quote so Sheets treats it as text.
// Also guards a leading-zero digit string (e.g. order number "092826") — Sheets'
// USER_ENTERED auto-number conversion otherwise silently drops the zero (F/U 2026-09).
function sheetSafe(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]|^0\d/.test(v) ? `'${v}` : v;
}

function credsPresent() {
  return !!SHEET_CREDS.client_email;
}

// Order status is monotonic — automated writes (invoice regen, tracking, delivered,
// paid, and the hourly poll) must only move it FORWARD. Without this, regenerating
// an invoice for an already-paid/delivered order silently resets it to Awaiting
// Payment. Rank blank/unknown as 0 so a first write always lands.
const STATUS_RANK = {
  'awaiting approval': 1, 'awaiting customer approval': 1, 'awaiting payment': 2,
  'in progress': 3, 'pending': 3, 'paid': 3,
  'in transit': 4, 'shipped': 4, 'delivered': 5,
};
const statusRank = (s) => STATUS_RANK[String(s || '').trim().toLowerCase()] || 0;

// Google's binding limit here is READS PER MINUTE PER USER (60), not per
// project: every call impersonates mayor@ through domain-wide delegation, so the
// whole service shares one user's budget. Rebuilding the JWT on every call also
// re-minted an access token each time — memoize the pair.
let _clients = null;

// A 429 from Sheets means "come back in a moment", not "this order failed". A
// wide post-deploy Refresh (normal — see mayor-docs 07-known-quirks: a restart
// resets the refresh window) legitimately touches every recent deal at once, and
// without a retry those orders were dropped and alert-emailed instead.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimited(e) {
  const code = Number((e && (e.code || e.status)) || (e && e.response && e.response.status) || 0);
  if (code === 429 || code === 503) return true;
  return /quota exceeded|rate ?limit|rateLimitExceeded|userRateLimitExceeded/i.test((e && e.message) || '');
}

async function withRetry(label, fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
      const wait = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400);
      console.warn(`${label}: rate limited by Google, retrying in ${wait}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
      await sleep(wait);
    }
  }
}

function getClients() {
  if (!SHEET_ID) throw new Error('MO_SHEET_ID is not set — refusing to run against the dead fallback sheet.');
  if (_clients) return _clients;
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
  _clients = { sheets: google.sheets({ version: 'v4', auth }), drive: google.drive({ version: 'v3', auth }) };
  return _clients;
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
  const commissionForTotal = num(p.commission);
  const total = p.total && Number(p.total) > 0
    ? Number(p.total)
    : subtotal + shipForTotal + customForTotal + rushForTotal + embForTotal + artForTotal - reimbForTotal - commissionForTotal;
  return { subtotal, total };
}

function buildDetailRow(p, driveLink) {
  const items = p.line_items || [];
  const get = (i, key) => (items[i] ? (items[i][key] || '') : '');
  const nameOrUrl = (i) => get(i, 'url') || get(i, 'product_name');
  const subtotalQty = p.subtotal_quantity != null ? p.subtotal_quantity : items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
  const { subtotal: effSubtotal, total: effTotal } = effectiveSubtotalAndTotal(p);
  // Column order lives in mo-sheet.js — reference cells by name, never position.
  return buildRow({
    deal_id: p.deal_id || '', deal_name: p.deal_name || '', deal_stage: p.deal_stage || '', tracking_number: p.tracking_number || '',
    customer_email: p.customer_email || '', order_number: p.order_number || '', product_page: p.product_page || '',
    print_background: p.print_background || '',
    club: p.club || '', shipping_address: p.shipping_address || '', address: p.address || '',
    ship_date: p.ship_date || '', in_hand_date: p.in_hand_date || '', payment_terms: p.payment_terms || '',
    // Product N column is name-or-URL: the image URL when there is one, else the
    // typed product name (portal.html nameLabel reads the same cell both ways).
    // Without the fallback a named slot landed blank and the portal showed the
    // generic "Custom Print Polo" instead of the name Matt typed in HubSpot.
    p1_url: nameOrUrl(0), p1_desc: get(0, 'description'), p1_sizes: get(0, 'sizes'), p1_qty: get(0, 'quantity'), p1_price: get(0, 'price'),
    p2_url: nameOrUrl(1), p2_desc: get(1, 'description'), p2_sizes: get(1, 'sizes'), p2_qty: get(1, 'quantity'), p2_price: get(1, 'price'),
    p3_url: nameOrUrl(2), p3_desc: get(2, 'description'), p3_sizes: get(2, 'sizes'), p3_qty: get(2, 'quantity'), p3_price: get(2, 'price'),
    p4_url: nameOrUrl(3), p4_desc: get(3, 'description'), p4_sizes: get(3, 'sizes'),
    p5_url: nameOrUrl(4), p5_desc: get(4, 'description'), p5_sizes: get(4, 'sizes'),
    p4_qty: get(3, 'quantity'), p4_price: get(3, 'price'), p5_qty: get(4, 'quantity'), p5_price: get(4, 'price'),
    subtotal_quantity: subtotalQty || '', subtotal: effSubtotal || '',
    embroidery: p.embroidery || '',
    art_setup: (p.art_setup != null ? parseFloat(String(p.art_setup).replace(/[$,\s]/g, '')) || '' : ''),
    sample_reimbursement: p.sample_reimbursement || '', custom_label: p.custom_label || '', shipping: p.shipping || '', total: effTotal || '',
    commission: p.commission || '',
    payment_link: p.payment_link || '', payment_link_2: p.payment_link_2 || '',
    // Write an explicit '0' for "not struck" — a BLANK cell means "never set" and
    // the portal falls back to the legacy default (waived for emb/art, charged for
    // shipping, portal.js strikeCell). Collapsing false into '' made an explicitly
    // unstruck fee render struck in the portal while the total charged it.
    strike_embroidery: p.strike_embroidery ? '1' : '0', strike_art: p.strike_art ? '1' : '0', strike_shipping: p.strike_shipping ? '1' : '0',
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
    const res = await withRetry('read Users!A:C', () => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:C' }));
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
// prefetchedRows: the tab's A:H values already in hand (persistOrder batch-reads
// Order Info and the detail tab together), so this doesn't spend a second read.
async function writeRow(sheets, tab, { dealId, orderNumber }, rowData, prefetchedRows) {
  const isInfo = tab === 'Order Info';
  const dealIdx = isInfo ? INFO_DEAL_COL : 0;
  const orderIdx = isInfo ? 0 : 5;
  let rows = prefetchedRows;
  if (!rows) {
    const res = await withRetry(`read ${tab}!A:H`, () => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:H` }));
    rows = res.data.values || [];
  }
  const idx = matchRowIndex(rows, dealIdx, orderIdx, dealId, orderNumber);
  const targetRow = idx > 0 ? idx + 1 : firstEmptyRow(rows, orderIdx);
  await withRetry(`write ${tab}!A${targetRow}`, () => sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [rowData.map(sheetSafe)] },
  }));
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
  // from docType. Default to Awaiting Customer Approval only for a brand-new
  // order whose dropdown hasn't been set yet.
  const status = payload.order_status || 'Awaiting Customer Approval';
  if (!credsPresent()) {
    return { persisted: false, status, driveFileId: null, pdfUrl: null, skipped: 'no google credentials' };
  }
  try {
    const { sheets, drive } = getClients();
    const orderNumber = payload.order_number || '';
    const dealId = payload.deal_id || '';

    const { fileId, pdfUrl } = await uploadPdfToDrive(drive, orderNumber, docType, pdfBuffer);

    // Order Info: the row the portal lists. Keyed on deal_id (col H) so a HubSpot
    // rename updates in place; read A:I for the deal_id + current status (F3) +
    // deal_name (I, added F14 so the portal can sort by HubSpot's real Deal Name
    // instead of the order_number field, which doesn't always match it).
    // Batched with the detail tab below: two ranges, ONE read request. Separately
    // these were 2 of the 3 reads every regenerated document cost, which is how a
    // 36-deal Refresh blew the per-minute read quota (2026-09-22).
    const tab = docType === 'invoice' ? 'Invoices' : 'Order Confirmations';
    const batch = await withRetry('read Order Info + detail tab', () => sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: ['Order Info!A:J', `${tab}!A:H`],
    }));
    const ranges = (batch.data && batch.data.valueRanges) || [];
    const infoRows = (ranges[0] && ranges[0].values) || [];
    const detailRows = (ranges[1] && ranges[1].values) || [];
    const infoIdx = matchRowIndex(infoRows, INFO_DEAL_COL, 0, dealId, orderNumber);
    if (infoIdx < 1) {
      await writeRow(sheets, 'Order Info', { dealId, orderNumber },
        [orderNumber, payload.club || '', payload.ship_date || '', payload.customer_email || '', status, '', '', dealId, payload.deal_name || '', payload.payment_status || ''].map(sheetSafe),
        infoRows);
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
      // Ship date was previously only set when the row was first created, so
      // clearing (or changing) it in HubSpot afterward never reached the sheet.
      // Unlike the other synced fields below, this one must sync TO blank too --
      // a cleared ship date is a real, common edit, not a missing read.
      if (String(row[2] || '') !== String(payload.ship_date || '')) {
        updates.push({ range: `Order Info!C${targetRow}`, values: [[sheetSafe(payload.ship_date || '')]] });
      }
      // Manual dropdown status is authoritative — write it whenever it's set and
      // differs (any direction, so Matt can correct it). A blank dropdown leaves
      // whatever's already on the sheet untouched.
      if (payload.order_status && String(row[4] || '') !== payload.order_status) {
        updates.push({ range: `Order Info!E${targetRow}`, values: [[sheetSafe(payload.order_status)]] });
      }
      if (payload.deal_name && String(row[INFO_DEALNAME_COL] || '') !== payload.deal_name) {
        updates.push({ range: `Order Info!I${targetRow}`, values: [[sheetSafe(payload.deal_name)]] });
      }
      // Payment Status is its own manual dropdown from HubSpot -- write it
      // whenever it's set and differs (any direction, same as Order Status).
      if (payload.payment_status && String(row[INFO_PAYMENTSTATUS_COL] || '') !== payload.payment_status) {
        updates.push({ range: `Order Info!J${targetRow}`, values: [[sheetSafe(payload.payment_status)]] });
      }
      // Keep the email column in sync with HubSpot -- previously only set when the
      // row was first created, so adding a second email to an existing deal (or
      // correcting a typo) never reached the sheet no matter how many times
      // Refresh ran. Also (re-)register every address so each can log in.
      if (payload.customer_email && String(row[3] || '') !== payload.customer_email) {
        updates.push({ range: `Order Info!D${targetRow}`, values: [[sheetSafe(payload.customer_email)]] });
        const emails = String(payload.customer_email).split(/[,;]+/).map((e) => e.trim()).filter(Boolean);
        for (const email of emails) await upsertUserEmail(sheets, email, payload.club);
      }
      if (updates.length) await withRetry('update Order Info', () => sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, resource: { valueInputOption: 'USER_ENTERED', data: updates } }));
    }

    // Detail row for the portal's document view — also keyed on deal_id (F10).
    await writeRow(sheets, tab, { dealId, orderNumber }, buildDetailRow(payload, pdfUrl), detailRows);

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
    const res = await withRetry('read Order Info!A:E', () => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Info!A:E' }));
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
    // Format like every other date on the sheet ("Monday, July 27, 2026"); the
    // trigger hands us the raw HubSpot value ("2026-08-12"). parseShipDate is
    // idempotent, so an already-formatted date passes through unchanged.
    if (deliveredDate != null && deliveredDate !== '') data.push({ range: `Order Info!G${row}`, values: [[sheetSafe(parseShipDate(deliveredDate) || deliveredDate)]] });
    if (data.length === 0) return { updated: false, status, skipped: 'no forward change' };

    await withRetry('update Order Info status', () => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    }));
    return { updated: true, status };
  } catch (e) {
    console.error('setOrderStatus failed:', e.message);
    return { updated: false, status, error: e.message };
  }
}

// Read both detail tabs ONCE and hand the result to every deal in a refresh run.
// This is the fix for the 2026-09-22 quota alert: dealDocPresence used to do two
// full-tab reads per deal, so a 36-deal sweep fired 72 reads inside a minute and
// exhausted the 60-reads-per-minute-per-user budget. The tabs don't change under
// us mid-run in a way that matters — a doc that appears during the sweep is
// picked up by the next one.
async function fetchDocPresenceIndex() {
  if (!credsPresent()) return null;
  const { sheets } = getClients();
  const res = await withRetry('read detail tabs', () => sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: ['Order Confirmations!A:F', 'Invoices!A:F'],
  }));
  const ranges = (res.data && res.data.valueRanges) || [];
  return {
    ocRows: (ranges[0] && ranges[0].values) || [],
    invRows: (ranges[1] && ranges[1].values) || [],
  };
}

// Which detail tabs already hold a row for this deal (by deal_id, fallback
// order_number)? Used by the refresh reconcile to update only docs that already
// exist — never materialize a premature OC/Invoice for a deal that was merely
// edited mid-stage. deal_id is col A(0), order_number col F(5) on both tabs.
// Pass `index` from fetchDocPresenceIndex to answer from memory at zero API
// cost; without it this costs one batched read.
async function dealDocPresence({ dealId, orderNumber, index }) {
  if (!credsPresent()) return { oc: false, invoice: false };
  const idx = index || await fetchDocPresenceIndex();
  if (!idx) return { oc: false, invoice: false };
  return {
    oc: matchRowIndex(idx.ocRows, 0, 5, dealId, orderNumber) >= 1,
    invoice: matchRowIndex(idx.invRows, 0, 5, dealId, orderNumber) >= 1,
  };
}

module.exports = { persistOrder, setOrderStatus, buildDetailRow, credsPresent, matchRowIndex, dealDocPresence, fetchDocPresenceIndex, isRateLimited, withRetry };
