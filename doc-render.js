// Shared OC/Invoice render module.
// Single source of truth for the Order Confirmation / Invoice PDF so the human
// tab (via /generate) and the Hermes agent produce byte-identical output.
//
// Usage:  const pdf = await renderInvoicePdf(data);   // Buffer

const PDFDocument = require('pdfkit');
const path = require('path');

const DEFAULT_LOGO_PATH = path.join(__dirname, 'Mayor_Logo_transparent.png');
const DEFAULT_W9 = 'https://drive.google.com/file/d/1iZD_sP2WQbfPrXkHIcPqf7XawDMP2Zi1/view';

const INK = '#1a1a18';
const BAND = '#1a1a18';
const LINE = '#cccccc';
const STRIPE = '#f9f9f8';

// Comma-separated, cents only when non-zero — matches the portal's fmtMoney so
// PDFs and the customer portal read the same, not like an accounting ledger.
function fmtMoney(n) {
  const num = Number(n) || 0;
  const hasCents = Math.round(num * 100) % 100 !== 0;
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 });
}

// SSRF-hardened: https only, image extension at the END of the path (not just
// anywhere in the URL), no redirects, 8s timeout, 5MB cap. Any failure => null
// (the PDF falls back to the product name).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;

// Address blocks arrive with their parts separated by newlines, but some carry a
// vertical tab (\v, a HubSpot multiline artefact) and a leading "/" instead — those
// rendered as one long unbroken line. Treat every break character as a line break
// and drop the leftover separator slash.
function addressLines(block) {
  return String(block == null ? '' : block)
    .split(/[\n\v\r\u2028\u2029]+/)
    .map((s) => s.trim().replace(/^\/\s*/, '').trim())
    .filter(Boolean);
}

async function fetchImageBuffer(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch (e) { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/\.(png|jpe?g|webp)$/i.test(parsed.pathname)) return null;
  // Shopify encodes the variant size in the filename (_5000x.png). The 5000px
  // originals are 6-8MB -- over MAX_IMAGE_BYTES -- so they were silently dropped
  // and the mockup just vanished from the PDF. Ask for a 600px variant (the cell renders ~40pt wide)
  // first, fall back to the original when there's no size suffix to swap.
  const candidates = [];
  const smaller = parsed.pathname.replace(/_(\d{3,5})x(\.(?:png|jpe?g|webp))$/i,
    (m, n, ext) => (Number(n) > 600 ? `_600x${ext}` : m));
  if (smaller !== parsed.pathname) {
    const alt = new URL(parsed.href);
    alt.pathname = smaller;
    candidates.push(alt.href);
  }
  candidates.push(parsed.href);
  for (const href of candidates) {
    try {
      const r = await fetch(href, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const len = Number(r.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) { console.warn(`image too large, skipped: ${href} (${len} bytes)`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) { console.warn(`image too large, skipped: ${href} (${buf.length} bytes)`); continue; }
      return buf;
    } catch (e) { /* try the next candidate */ }
  }
  return null;
}

// data = the /generate payload. logoPath is the Mayor script logo drawn top left.
async function renderInvoicePdf(data, logoPath = DEFAULT_LOGO_PATH) {
  // Pre-fetch product images as buffers (bounded — 5 slots). Mockups are
  // deliberately NOT rendered here: they live on the order page only, so the
  // downloaded document stays lean (and skips five image fetches per render).
  const imageBuffers = await Promise.all(
    (data.line_items || []).map((item, i) => (i < MAX_IMAGES ? fetchImageBuffer(item.url) : null))
  );
  const {
    order_number = '', club = '', address = '', shipping_address = '', ship_date = '', in_hand_date = '', invoice_date = '',
    date_label = 'Ship By',
    payment_link = '', payment_link_2 = '', w9_link = DEFAULT_W9,
    line_items = [], subtotal = 0, embroidery, art_setup, strike_embroidery = true, strike_art = true,
    shipping = 0, strike_shipping = false, sample_reimbursement = null,
    custom_label = null, rush_fee = null, payment_terms = '', total = 0,
    commission = null, sales_tax = null
  } = data;

  return await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = 612;
      const pageH = 792;
      const margin = 45;
      const contentW = pageW - margin * 2;

      const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,()\s]/g, '')); return isNaN(n) ? 0 : n; };
      const artSigned = (v) => {
        const s = String(v == null ? '' : v).trim();
        const magnitude = num(s);
        return (s.startsWith('-') || s.startsWith('(')) ? -Math.abs(magnitude) : magnitude;
      };

      // ── HEADER: Mayor block (left) + document title (right) ──
      let hy = margin;
      // Mayor script logo (black on transparent). The PNG has some empty space on
      // its left, so it's nudged left to line the lettering up with the address
      // below. Falls back to the plain word if the file can't be read.
      try {
        doc.image(logoPath, margin - 14, margin - 10, { fit: [130, 45] });
      } catch (e) {
        doc.fontSize(15).font('Helvetica-Bold').fillColor(INK)
           .text('MAYOR', margin, hy, { characterSpacing: 1 });
      }
      hy += 38;
      doc.fontSize(9).font('Helvetica').fillColor(INK)
         .text('870 Inman Village Parkway NE', margin, hy);
      hy += 11;
      doc.text('Suite 533', margin, hy);
      hy += 11;
      doc.text('Atlanta, GA 30307', margin, hy);
      hy += 11;
      doc.text('339-206-2111  |  mayor@mayorclothing.com', margin, hy);

      const docTitle = data.type === 'confirmation' ? 'ORDER CONFIRMATION' : 'INVOICE';
      doc.fontSize(20).font('Helvetica-Bold').fillColor(INK)
         .text(docTitle, margin, margin, { width: contentW, align: 'right', characterSpacing: 1 });
      // The order name/number under the title -- hidden entirely when there is none.
      if (String(order_number || '').trim()) {
        doc.fontSize(9).font('Helvetica').fillColor(INK)
           .text('No. ' + String(order_number).trim(), margin, margin + 26, { width: contentW, align: 'right' });
      }
      // Document date from HubSpot's Invoice Date; no value => no line at all.
      if (invoice_date && String(invoice_date).trim()) {
        doc.fontSize(9).font('Helvetica').fillColor(INK)
           .text(String(invoice_date).trim(), margin, margin + 40, { width: contentW, align: 'right' });
      }

      // One spacing rule for the whole page: 14pt between every section.
      const GAP = 14;
      let y = margin + 79 + GAP;

      // ── Helper: a full-width box with a dark banded header label ──
      const band = (label, boxY, h) => {
        doc.rect(margin, boxY, contentW, 16).fill(BAND);
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
           .text(label, margin + 8, boxY + 4.5, { characterSpacing: 0.5 });
        doc.rect(margin, boxY, contentW, h).lineWidth(0.4).stroke(LINE);
        doc.fillColor(INK).font('Helvetica');
      };

      const hasAddress = address && address.trim();
      const hasShipping = hasAddress && shipping_address && shipping_address.trim() && shipping_address.trim() !== address.trim();
      const primaryAddress = hasShipping ? address : (address || shipping_address);

      // Two different addresses: ONE box, shipping on the left and billing on the right, under one
      // black bar (same half-way divider as the Ship By / Payment row below). One address only: the
      // full-width combined box.
      if (hasShipping) {
        const colW = contentW / 2;
        const shipLines = addressLines(shipping_address);
        const billLines = addressLines(address);
        const lineH = (t) => Math.max(12, doc.font('Helvetica').fontSize(9).heightOfString(t || ' ', { width: colW - 16 }) + 1);
        const colH = (lines) => lines.reduce((h, t) => h + lineH(t), 0);
        const boxH = 24 + Math.max(colH(shipLines), colH(billLines), 12);
        doc.rect(margin, y, contentW, 16).fill(BAND);
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
           .text('SHIPPING ADDRESS', margin + 8, y + 4.5, { characterSpacing: 0.5 })
           .text('BILLING ADDRESS', margin + colW + 8, y + 4.5, { characterSpacing: 0.5 });
        doc.rect(margin, y, contentW, boxH).lineWidth(0.4).stroke(LINE);
        doc.moveTo(margin + colW, y).lineTo(margin + colW, y + boxH).lineWidth(0.4).stroke(LINE);
        doc.fillColor(INK).fontSize(9).font('Helvetica');
        [[shipLines, margin + 8], [billLines, margin + colW + 8]].forEach(([lines, lx]) => {
          let ly = y + 22;
          lines.forEach((line) => { doc.text(line, lx, ly, { width: colW - 16 }); ly += lineH(line); });
        });
        y += boxH + GAP;
      } else {
        const addrLines = addressLines(primaryAddress);
        // Skip the bold name line when the address itself already starts with
        // it (common in real address data) -- avoids printing it twice.
        // The Customer field can hold several names as "Name A / Name B" -- one
        // bold line each.
        const shownClubs = String(club || '').split(' / ').map((s) => s.trim()).filter(Boolean)
          .filter((c) => !addrLines[0] || addrLines[0].trim().toLowerCase() !== c.toLowerCase());
        const boxH = 24 + shownClubs.length * 12 + Math.max(addrLines.length, 1) * 12;
        band('SHIPPING / BILLING ADDRESS', y, boxH);
        let ly = y + 22;
        shownClubs.forEach((c) => {
          doc.fontSize(9).font('Helvetica-Bold').text(c, margin + 8, ly, { width: contentW - 16 });
          ly += 12;
        });
        doc.fontSize(9).font('Helvetica');
        addrLines.forEach(line => { doc.text(line, margin + 8, ly, { width: contentW - 16 }); ly += 12; });
        y += boxH + GAP;
      }

      // SHIP BY / IN-HAND / PAYMENT -- compact banded row with one column per value
      // that exists, same as the order page (which shows each only when it has one).
      const hasDate = ship_date && String(ship_date).trim();
      const hasInHand = in_hand_date && String(in_hand_date).trim();
      // The payment field can hold plain text instead of a link ("Paid by check
      // #1042"): an https link prints as its address (and is the hyperlink); anything else
      // prints exactly as typed.
      const payVals = [payment_link, payment_link_2].map((l) => String(l || '').trim()).filter(Boolean);
      const isUrl = (v) => /^https:\/\//i.test(v);
      const payPieces = payVals.length > 1
        ? payVals.map((v, i) => ({ v, label: i === 0 ? 'Deposit' : 'Final Payment' }))
        : payVals.map((v) => ({ v, label: '' }));
      // A link prints as its address (without "https://") and is itself the hyperlink, so a printed
      // copy shows what to type. Two links get "Deposit" / "Final Payment" labels.
      const shortUrl = (v) => v.replace(/^https?:\/\//i, '');
      const payLines = (pc) => (isUrl(pc.v)
        ? [...(pc.label ? [{ t: pc.label, link: null, underline: false }] : []), { t: shortUrl(pc.v), link: pc.v, underline: true }]
        : [{ t: (pc.label ? pc.label + ': ' : '') + pc.v, link: null, underline: false }]);
      const PAY_GAP = 5;
      const payHeight = (width) => payPieces.reduce((h, pc, k) => h + (k ? PAY_GAP : 0)
        + payLines(pc).reduce((s, ln) => s + doc.font('Helvetica').fontSize(9).heightOfString(ln.t, { width }), 0), 0);
      const infoCols = [];
      if (hasDate) infoCols.push({ label: date_label.toUpperCase(), text: String(ship_date) });
      if (hasInHand) infoCols.push({ label: 'IN-HAND', text: String(in_hand_date) });
      if (payVals.length) infoCols.push({ label: 'PAYMENT', pay: true });
      if (infoCols.length) {
        const colW = contentW / infoCols.length;
        const cellH = (c) => (c.pay
          ? payHeight(colW - 16)
          : doc.font('Helvetica').fontSize(9).heightOfString(c.text, { width: colW - 16 }));
        const boxH = Math.max(32, 20 + Math.max(...infoCols.map(cellH)) + 6);
        doc.rect(margin, y, contentW, 16).fill(BAND);
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
        infoCols.forEach((c, i) => doc.text(c.label, margin + colW * i + 8, y + 4.5));
        doc.rect(margin, y, contentW, boxH).lineWidth(0.4).stroke(LINE);
        for (let i = 1; i < infoCols.length; i++) {
          doc.moveTo(margin + colW * i, y).lineTo(margin + colW * i, y + boxH).lineWidth(0.4).stroke(LINE);
        }
        doc.fillColor(INK).fontSize(9).font('Helvetica');
        infoCols.forEach((c, i) => {
          const cx = margin + colW * i + 8;
          if (!c.pay) { doc.fontSize(9).text(c.text, cx, y + 20, { width: colW - 16 }); return; }
          doc.fontSize(9);
          let py = y + 20;
          payPieces.forEach((pc, k) => {
            if (k) py += PAY_GAP;
            payLines(pc).forEach((ln) => {
              doc.text(ln.t, cx, py, { width: colW - 16, link: ln.link, underline: ln.underline });
              py += doc.heightOfString(ln.t, { width: colW - 16 });
            });
          });
        });
        y += boxH + GAP;
      }

      // ── LINE ITEMS TABLE (full width) ──
      // Product column is 93pt: its text area (pW - 10 = 83pt) keeps "Men's Custom Print" (80.7pt with
      // its trailing space at 9pt) on one line.
      const pW = 93, qW = 45, prW = 55, aW = 65;
      const dW = contentW - pW - qW - prW - aW;
      const cP = margin, cD = cP + pW, cQ = cD + dW, cPr = cQ + qW, cA = cPr + prW;

      const hH = 18;
      // Usable bottom of the page. Anything that would cross it starts a new page.
      const pageBottom = pageH - margin;
      let pageHasRows = false;   // true once a product row has been drawn on the current page
      const drawTableHeader = () => {
        pageHasRows = false;
        doc.rect(margin, y, contentW, hH).fill(BAND);
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
        doc.text('PRODUCT', cP + 6, y + 5, { width: pW - 6 });
        doc.text('DESCRIPTION', cD + 3, y + 5, { width: dW - 3 });
        doc.text('QTY', cQ, y + 5, { width: qW, align: 'center' });
        doc.text('PRICE', cPr, y + 5, { width: prW, align: 'center' });
        doc.text('AMOUNT', cA, y + 5, { width: aW - 6, align: 'right' });
        doc.fillColor(INK);
        y += hH;
      };

      // ── Totals rows (built up front so the table knows how much room the tail needs) ──
      const calcSubtotal = line_items.reduce((s, i) => s + (parseFloat(String(i.amount).replace(/[$,]/g, '')) || (Number(i.quantity) * Number(i.price)) || 0), 0);
      const effectiveSubtotal = subtotal && Number(subtotal) > 0 ? Number(subtotal) : calcSubtotal;
      const embForTotal = strike_embroidery ? 0 : num(embroidery);
      const artForTotal = strike_art ? 0 : artSigned(art_setup);
      const shipForTotal = strike_shipping ? 0 : num(shipping);
      const reimbForTotal = num(sample_reimbursement);
      const customForTotal = num(custom_label);
      const rushForTotal = num(rush_fee);
      const commissionForTotal = num(commission);
      const taxForTotal = Math.max(num(sales_tax), 0);
      const effectiveTotal = total && Number(total) > 0
        ? Number(total)
        : effectiveSubtotal + shipForTotal + customForTotal + rushForTotal + embForTotal + artForTotal + taxForTotal - reimbForTotal - commissionForTotal;
      const qtyTotal = line_items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

      const totRows = [];
      totRows.push(['Subtotal', fmtMoney(effectiveSubtotal), false, false, String(qtyTotal)]);
      if (num(embroidery) > 0) totRows.push(['Embroidery', fmtMoney(num(embroidery)), strike_embroidery, false]);
      if (art_setup != null && art_setup !== 0 && art_setup !== '') {
        const artNum = parseFloat(String(art_setup).replace(/[$,\s]/g, ''));
        if (!isNaN(artNum) && artNum !== 0) {
          totRows.push(['Art Setup', artNum < 0 ? `(${fmtMoney(Math.abs(artNum))})` : fmtMoney(artNum), strike_art, false]);
        }
      }
      if (rush_fee && num(rush_fee) !== 0) totRows.push(['Expedited Order', fmtMoney(rush_fee), false, false]);
      if (num(sample_reimbursement) > 0) totRows.push(['Sample Reimbursement', `(${fmtMoney(num(sample_reimbursement))})`, false, false]);
      if (num(custom_label) > 0) totRows.push(['Custom Woven Labels & Hang Tags', fmtMoney(num(custom_label)), false, false]);
      if (num(commission) > 0) totRows.push(['Commission', `(${fmtMoney(num(commission))})`, false, false]);
      if (num(shipping) !== 0) totRows.push(['Shipping', fmtMoney(num(shipping)), strike_shipping, false]);
      if (taxForTotal > 0) totRows.push(['Sales Tax', fmtMoney(taxForTotal), false, false]);
      totRows.push(['Total', fmtMoney(effectiveTotal), false, true]);

      const rowH2 = 17;
      const totalsBoxH = totRows.length * rowH2;

      // ── Payment terms + closing line (also built up front) ──
      const isSplitPayment2 = !!(payment_link_2 && payment_link_2.trim());
      let termsText;
      if (payment_terms && payment_terms.trim()) {
        const custom = payment_terms.trim().replace(/\.$/, '');
        termsText = /no returns or exchanges/i.test(custom)
          ? custom + '. '
          : custom + '. Based on our custom model, garments are produced specially for each customer. Once customers approve their order, they are responsible for payment of its full value. There are no returns or exchanges. All sales are final. ';
      } else {
        const leadIn = isSplitPayment2 ? '50% deposit, 50% on receipt. ' : 'Due on receipt. ';
        termsText = leadIn + 'Based on our custom model, garments are produced specially for each customer. Once customers approve their order, they are responsible for payment of its full value. There are no returns or exchanges. All sales are final. ';
      }
      const termsH = doc.font('Helvetica').fontSize(9).heightOfString(termsText + 'Here is our W-9.', { width: contentW - 16 });
      const leftBoxH = termsH + 28;
      const docWord = data.type === 'confirmation' ? 'order confirmation' : 'invoice';
      const closingText = `If you have any questions about this ${docWord}, please contact Customer Service at 339-206-2111 or mayor@mayorclothing.com`;
      const closeH = doc.font('Helvetica').fontSize(9).heightOfString(closingText, { width: contentW - 80, align: 'center' });

      // Height of everything that follows the product table: totals, payment terms, closing line.
      const tailH = totalsBoxH + GAP + leftBoxH + GAP + closeH;

      if (y + hH + 60 > pageBottom) { doc.addPage(); y = margin; }   // no header stranded at the bottom of a page
      drawTableHeader();

      line_items.forEach((item, i) => {
        const sizesText = (item.sizes || '').trim();
        const descText = [((item.description || '').replace(/\\n/g, '\n').replace(/ \/ /g, '\n')), sizesText ? 'Sizes: ' + sizesText : ''].filter(Boolean).join('\n');
        const imgBuf = imageBuffers[i] || null;
        const imgSize = 52;
        // Same "Additional Details" link the order page shows under the description.
        const productLink = item.product_page || (i === 0 ? data.product_page : '') || '';
        const textH = (t) => doc.font('Helvetica').fontSize(9).heightOfString(t || ' ', { width: dW - 6, lineGap: 1.5 });
        const itemAmount = Number(item.amount) || (Number(item.quantity) * Number(item.price)) || 0;
        const hasDualPrice = item.orig_price && Number(item.orig_price) > 0;
        const prodH = doc.font('Helvetica').fontSize(9).heightOfString(item.product || '', { width: pW - 10 });
        // Smallest the FIRST piece of a row can be: it carries the product, qty, price and amount.
        const firstMinH = Math.max(imgBuf ? imgSize + 10 : 0, prodH + 14, hasDualPrice ? 40 : 26);

        // Draws one piece of a product row. Only the first piece carries product/qty/price/amount;
        // only the last piece carries the "Additional Details" link.
        const drawRowPiece = (rowY, rowH, text, isFirst, isLast) => {
          pageHasRows = true;
          doc.rect(margin, rowY, contentW, rowH).lineWidth(0.4).stroke(LINE);
          doc.fontSize(9).font('Helvetica').fillColor(INK);
          if (isFirst) {
            if (imgBuf) {
              try {
                doc.image(imgBuf, cP + 5, rowY + 4, { fit: [pW - 10, Math.min(rowH - 8, imgSize + 2)], align: 'center', valign: 'center', link: productLink });
              } catch (e) {
                doc.text(item.product || '', cP + 6, rowY + 7, { width: pW - 10, underline: false });
              }
            } else {
              doc.text(item.product || '', cP + 6, rowY + 7, { width: pW - 10, underline: false });
            }
          }
          doc.text(text, cD + 3, rowY + 7, { width: dW - 6, lineGap: 1.5 });
          if (isLast && productLink) {
            const linkY = rowY + 7 + (text ? textH(text) + 2 : 0);
            doc.fontSize(9).fillColor(INK).text('Additional Details', cD + 3, linkY, { width: dW - 6, link: productLink, underline: true });
            doc.fontSize(9);
          }
          if (!isFirst) return;
          doc.text(String(item.quantity || ''), cQ, rowY + 7, { width: qW, align: 'center' });

          if (item.orig_price && Number(item.orig_price) > 0) {
            const origText = fmtMoney(item.orig_price);
            const actText = fmtMoney(item.price);
            doc.text(origText, cPr, rowY + 5, { width: prW, align: 'center' });
            const origW = doc.widthOfString(origText);
            const origX = cPr + (prW - origW) / 2;
            const midY = rowY + 5 + 8.5 * 0.35;
            doc.moveTo(origX, midY).lineTo(origX + origW, midY).lineWidth(0.8).stroke(INK);
            doc.text(actText, cPr, rowY + 18, { width: prW, align: 'center' });
          } else {
            doc.text(fmtMoney(item.price), cPr, rowY + 7, { width: prW, align: 'center' });
          }

          if (item.orig_price && Number(item.orig_price) > 0) {
            const origAmt = fmtMoney(Number(item.orig_price) * Number(item.quantity));
            const actAmt = fmtMoney(itemAmount);
            doc.text(origAmt, cA, rowY + 5, { width: aW - 6, align: 'right' });
            const origAmtW = doc.widthOfString(origAmt);
            const origAmtX = cA + aW - 6 - origAmtW;
            const midY = rowY + 5 + 8.5 * 0.35;
            doc.moveTo(origAmtX, midY).lineTo(origAmtX + origAmtW, midY).lineWidth(0.8).stroke(INK);
            doc.text(actAmt, cA, rowY + 18, { width: aW - 6, align: 'right' });
          } else {
            // Plain amount, $0 included -- same as the order page (no strike-through).
            doc.text(fmtMoney(itemAmount), cA, rowY + 7, { width: aW - 6, align: 'right' });
          }
        };

        const linkH = productLink ? 12 : 0;
        const wholeH = Math.max(textH(descText) + linkH + 14, firstMinH);

        if (y + wholeH <= pageBottom) {
          // Fits on this page. But if this is the LAST product and the totals / terms / closing line would
          // not also fit beneath it, bring this product to the next page so it travels with them -- a page
          // should never hold only boilerplate.
          if (i === line_items.length - 1 && pageHasRows && y + wholeH + tailH > pageBottom) {
            doc.addPage();
            y = margin;
            drawTableHeader();
          }
          drawRowPiece(y, wholeH, descText, true, true);
          y += wholeH;
          return;
        }

        // Doesn't fit. If a fresh page would hold it whole, just start the row there.
        const freshAvail = pageBottom - (margin + hH);
        if (wholeH <= freshAvail && pageHasRows) {
          doc.addPage();
          y = margin;
          drawTableHeader();
          drawRowPiece(y, wholeH, descText, true, true);
          y += wholeH;
          return;
        }

        // Taller than a whole page (or nothing sensible fits): flow the description across pages,
        // one paragraph at a time, repeating the column header on each new page.
        let paras = descText.split('\n');
        let isFirst = true;
        while (paras.length) {
          let avail = pageBottom - y;
          if (avail < Math.max(firstMinH, 60) && pageHasRows) {
            doc.addPage(); y = margin; drawTableHeader();
            avail = pageBottom - y;
          }
          const take = [];
          let used = 14;
          while (paras.length) {
            const h = textH(paras[0]);
            const lastIfTaken = paras.length === 1;
            const extra = lastIfTaken ? linkH : 0;
            if (take.length && used + h + extra > avail) break;
            take.push(paras.shift());
            used += h;
          }
          const isLast = paras.length === 0;
          const pieceH = Math.max(used + (isLast ? linkH : 0), isFirst ? firstMinH : 26);
          drawRowPiece(y, pieceH, take.join('\n'), isFirst, isLast);
          y += pieceH;
          isFirst = false;
          if (!isLast) { doc.addPage(); y = margin; drawTableHeader(); }
        }
      });

      // ── Totals box: attached to the bottom of the product table, full width, labels under PRODUCT,
      // the quantity under QTY and the amounts under AMOUNT. Only the Total row is bold. ──
      let totalsY = y;
      // The totals stay together: if they don't fit under the last product row, they start a new page.
      if (totalsY + totalsBoxH > pageBottom) {
        doc.addPage();
        totalsY = margin;
      }
      doc.rect(margin, totalsY, contentW, totalsBoxH).lineWidth(0.4).stroke(LINE);
      let ty = totalsY;
      totRows.forEach(([label, value, strike, bold, qtyCell]) => {
        doc.moveTo(margin, ty).lineTo(margin + contentW, ty).lineWidth(0.4).stroke(LINE);
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK)
           .text(label, cP + 6, ty + 5, { width: pW + dW - 12, lineBreak: false, ellipsis: true });
        if (qtyCell) doc.fontSize(9).font('Helvetica').text(qtyCell, cQ, ty + 5, { width: qW, align: 'center' });   // same column as the item quantities
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(value, cA, ty + 5, { width: aW - 6, align: 'right' });          // same column as the item amounts
        if (strike) {
          const tw = doc.widthOfString(value);
          const tx = cA + aW - 6 - tw;
          const midY = ty + rowH2 / 2;
          doc.moveTo(tx, midY).lineTo(tx + tw, midY).lineWidth(0.8).stroke(INK);
        }
        ty += rowH2;
      });

      // ── Payment Terms: full-width box beneath the totals ──
      let termsY = totalsY + totalsBoxH + GAP;
      // Terms + the Customer Service line travel together: if they don't both fit under the totals,
      // they go to a new page.
      if (termsY + leftBoxH + GAP + closeH > pageBottom) {
        doc.addPage();
        termsY = margin;
      }
      doc.rect(margin, termsY, contentW, 16).fill(BAND);
      doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAYMENT TERMS', margin + 8, termsY + 4.5);
      doc.rect(margin, termsY, contentW, leftBoxH).lineWidth(0.4).stroke(LINE);
      doc.fillColor(INK).fontSize(9).font('Helvetica')
         .text(termsText, margin + 8, termsY + 22, { width: contentW - 16, continued: true })
         .text('Here', { continued: true, underline: true, link: w9_link })
         .text(' is our W-9.', { underline: false });

      // ── Closing line under the boxes (replaces the old page-bottom footer): who to contact ──
      const closeY = termsY + leftBoxH + GAP;
      doc.fontSize(9).font('Helvetica').fillColor(INK)
         .text(closingText, margin + 40, closeY, { width: contentW - 80, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderInvoicePdf };
