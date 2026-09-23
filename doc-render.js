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

// data = the /generate payload. logoPath is accepted for backward compatibility
// with callers, but is no longer used -- the logo was removed from the PDF.
async function renderInvoicePdf(data, logoPath = DEFAULT_LOGO_PATH) {
  // Pre-fetch product images as buffers (bounded — 5 slots). Mockups are
  // deliberately NOT rendered here: they live on the order page only, so the
  // downloaded document stays lean (and skips five image fetches per render).
  const imageBuffers = await Promise.all(
    (data.line_items || []).map((item, i) => (i < MAX_IMAGES ? fetchImageBuffer(item.url) : null))
  );
  const {
    order_number = '', club = '', address = '', shipping_address = '', ship_date = '',
    date_label = 'Ship By',
    payment_link = '', payment_link_2 = '', w9_link = DEFAULT_W9,
    line_items = [], subtotal = 0, embroidery, art_setup, strike_embroidery = true, strike_art = true,
    shipping = 0, strike_shipping = false, sample_reimbursement = null,
    custom_label = null, rush_fee = null, payment_terms = '', total = 0,
    commission = null
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
      doc.fontSize(15).font('Helvetica-Bold').fillColor(INK)
         .text('MAYOR', margin, hy, { characterSpacing: 1 });
      hy += 19;
      doc.fontSize(8).font('Helvetica').fillColor('#555')
         .text('870 Inman Village Parkway NE, Suite 533', margin, hy);
      hy += 11;
      doc.text('Atlanta, GA 30307', margin, hy);
      hy += 11;
      doc.text('339-206-2111  |  mayor@mayorclothing.com', margin, hy);

      const docTitle = data.type === 'confirmation' ? 'ORDER CONFIRMATION' : 'INVOICE';
      doc.fontSize(20).font('Helvetica-Bold').fillColor(INK)
         .text(docTitle, margin, margin, { width: contentW, align: 'right', characterSpacing: 1 });
      doc.fontSize(10).font('Helvetica').fillColor('#555')
         .text('Order ' + order_number, margin, margin + 26, { width: contentW, align: 'right' });

      let y = margin + 62;
      doc.moveTo(margin, y).lineTo(pageW - margin, y).lineWidth(1).stroke(INK);
      y += 14;

      // ── Helper: a full-width box with a dark banded header label ──
      const band = (label, boxY, h) => {
        doc.rect(margin, boxY, contentW, 16).fill(BAND);
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
           .text(label, margin + 8, boxY + 4.5, { characterSpacing: 0.5 });
        doc.rect(margin, boxY, contentW, h).lineWidth(0.75).stroke(LINE);
        doc.fillColor(INK).font('Helvetica');
      };

      const hasAddress = address && address.trim();
      const hasShipping = hasAddress && shipping_address && shipping_address.trim() && shipping_address.trim() !== address.trim();
      const primaryAddress = hasShipping ? address : (address || shipping_address);

      // SHIP TO box (only when it differs from billing), then CUSTOMER/BILLING box —
      // shipping shown above billing, matching the order page.
      if (hasShipping) {
        const shipLines = addressLines(shipping_address);
        const boxH = 24 + shipLines.length * 12;
        band('SHIP TO', y, boxH);
        let ly = y + 22;
        doc.fontSize(9).font('Helvetica');
        shipLines.forEach(line => { doc.text(line, margin + 8, ly, { width: contentW - 16 }); ly += 12; });
        y += boxH + 10;
      }

      {
        const addrLines = addressLines(primaryAddress);
        // Skip the bold name line when the address itself already starts with
        // it (common in real address data) -- avoids printing it twice.
        const showClub = club && club.trim() && (!addrLines[0] || addrLines[0].trim().toLowerCase() !== club.trim().toLowerCase());
        const boxH = 24 + (showClub ? 12 : 0) + Math.max(addrLines.length, 1) * 12;
        band(hasShipping ? 'CUSTOMER / BILLING' : 'CUSTOMER', y, boxH);
        let ly = y + 22;
        if (showClub) {
          doc.fontSize(9).font('Helvetica-Bold').text(club, margin + 8, ly, { width: contentW - 16 });
          ly += 12;
        }
        doc.fontSize(9).font('Helvetica');
        addrLines.forEach(line => { doc.text(line, margin + 8, ly, { width: contentW - 16 }); ly += 12; });
        y += boxH + 10;
      }

      // SHIP BY / PAYMENT — compact two-column banded row (only when there's a date)
      const hasDate = ship_date && String(ship_date).trim();
      if (hasDate) {
        const colW = contentW / 2;
        doc.rect(margin, y, contentW, 16).fill(BAND);
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
        doc.text(date_label.toUpperCase(), margin + 8, y + 4.5);
        doc.text('PAYMENT', margin + colW + 8, y + 4.5);
        doc.rect(margin, y, contentW, 32).lineWidth(0.75).stroke(LINE);
        doc.moveTo(margin + colW, y).lineTo(margin + colW, y + 32).lineWidth(0.75).stroke(LINE);
        doc.fillColor(INK).fontSize(9).font('Helvetica');
        doc.text(ship_date, margin + 8, y + 20, { width: colW - 16 });
        const isSplitPayment = !!(payment_link_2 && payment_link_2.trim());
        if (isSplitPayment) {
          doc.fontSize(8).text('50% Deposit', margin + colW + 8, y + 20, { link: payment_link || '#', underline: true, continued: true });
          doc.text('   /   ', { link: null, underline: false, continued: true });
          doc.text('50% on Receipt', { link: payment_link_2, underline: true });
        } else {
          doc.fontSize(9).text('Click Here', margin + colW + 8, y + 20, { link: payment_link || '#', underline: true });
        }
        y += 32 + 10;
      }

      // ── LINE ITEMS TABLE (full width) ──
      const pW = 70, qW = 45, prW = 55, aW = 65;
      const dW = contentW - pW - qW - prW - aW;
      const cP = margin, cD = cP + pW, cQ = cD + dW, cPr = cQ + qW, cA = cPr + prW;

      const hH = 18;
      doc.rect(margin, y, contentW, hH).fill(BAND);
      doc.fillColor('white').fontSize(8.5).font('Helvetica-Bold');
      doc.text('PRODUCT', cP + 6, y + 5, { width: pW - 6 });
      doc.text('DESCRIPTION', cD + 3, y + 5, { width: dW - 3 });
      doc.text('QTY', cQ, y + 5, { width: qW, align: 'right' });
      doc.text('PRICE', cPr, y + 5, { width: prW, align: 'right' });
      doc.text('AMOUNT', cA, y + 5, { width: aW - 6, align: 'right' });
      doc.fillColor(INK);
      y += hH;

      line_items.forEach((item, i) => {
        const descText = [((item.description || '').replace(/\\n/g, '\n').replace(/ \/ /g, '\n')), item.sizes].filter(Boolean).join('\n');
        const imgBuf = imageBuffers[i] || null;
        const imgSize = 52;
        const descH = doc.fontSize(8.5).heightOfString(descText, { width: dW - 8, lineGap: 1.5 });
        const hasDualPrice = item.orig_price && Number(item.orig_price) > 0;
        const prodH = doc.fontSize(8.5).heightOfString(item.product || '', { width: pW - 10 });
        const rowH = Math.max(imgBuf ? imgSize + 10 : 0, descH + 14, prodH + 14, hasDualPrice ? 40 : 26);

        if (i % 2 === 1) { doc.rect(margin, y, contentW, rowH).fill(STRIPE).fillColor(INK); }
        doc.rect(margin, y, contentW, rowH).lineWidth(0.4).stroke(LINE);

        doc.fontSize(8.5).font('Helvetica').fillColor(INK);
        if (imgBuf) {
          try {
            doc.image(imgBuf, cP + 5, y + 4, { fit: [pW - 10, rowH - 8], align: 'center', valign: 'center', link: item.product_page || (i === 0 ? data.product_page : '') || '' });
          } catch (e) {
            doc.text(item.product || '', cP + 6, y + 7, { width: pW - 10, underline: false });
          }
        } else {
          doc.text(item.product || '', cP + 6, y + 7, { width: pW - 10, underline: false });
        }
        doc.text(descText, cD + 3, y + 7, { width: dW - 6, lineGap: 1.5 });
        doc.text(String(item.quantity || ''), cQ, y + 7, { width: qW, align: 'right' });

        if (item.orig_price && Number(item.orig_price) > 0) {
          const origText = fmtMoney(item.orig_price);
          const actText = fmtMoney(item.price);
          doc.text(origText, cPr, y + 5, { width: prW, align: 'right' });
          const origW = doc.widthOfString(origText);
          const origX = cPr + prW - origW;
          const midY = y + 5 + 8.5 * 0.35;
          doc.moveTo(origX, midY).lineTo(origX + origW, midY).lineWidth(0.8).stroke(INK);
          doc.text(actText, cPr, y + 18, { width: prW, align: 'right' });
        } else {
          doc.text(item.price ? fmtMoney(item.price) : '', cPr, y + 7, { width: prW, align: 'right' });
        }

        if (item.orig_price && Number(item.orig_price) > 0) {
          const origAmt = fmtMoney(Number(item.orig_price) * Number(item.quantity));
          const actAmt = fmtMoney(item.amount);
          doc.text(origAmt, cA, y + 5, { width: aW - 6, align: 'right' });
          const origAmtW = doc.widthOfString(origAmt);
          const origAmtX = cA + aW - 6 - origAmtW;
          const midY = y + 5 + 8.5 * 0.35;
          doc.moveTo(origAmtX, midY).lineTo(origAmtX + origAmtW, midY).lineWidth(0.8).stroke(INK);
          doc.text(actAmt, cA, y + 18, { width: aW - 6, align: 'right' });
        } else {
          const amtText = item.amount ? fmtMoney(item.amount) : (Number(item.price) === 0 ? fmtMoney(0) : '');
          doc.text(amtText, cA, y + 7, { width: aW - 6, align: 'right' });
          if (Number(item.price) === 0 && amtText) {
            const tw = doc.widthOfString(amtText);
            const tx = cA + aW - 6 - tw;
            const zMid = y + 7 + 8.5 * 0.35;
            doc.moveTo(tx, zMid).lineTo(tx + tw, zMid).lineWidth(0.8).stroke(INK);
          }
          if (Number(item.price) === 0) {
            const prText = fmtMoney(0);
            const ptw = doc.widthOfString(prText);
            const ptx = cPr + prW - ptw;
            const zMid = y + 7 + 8.5 * 0.35;
            doc.moveTo(ptx, zMid).lineTo(ptx + ptw, zMid).lineWidth(0.8).stroke(INK);
          }
        }
        y += rowH;
      });
      y += 12;

      // ── BOTTOM ROW: Payment Terms box (left) + Totals box (right) ──
      const leftBoxW = contentW * 0.48;
      const rightBoxW = contentW - leftBoxW - 14;
      const rightBoxX = margin + leftBoxW + 14;

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
      const termsH = doc.fontSize(8).heightOfString(termsText + 'Here is our W-9.', { width: leftBoxW - 16 });
      const leftBoxH = Math.max(termsH + 30, 90);

      doc.rect(margin, y, leftBoxW, 16).fill(BAND);
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PAYMENT TERMS', margin + 8, y + 4.5);
      doc.rect(margin, y, leftBoxW, leftBoxH).lineWidth(0.75).stroke(LINE);
      doc.fillColor(INK).fontSize(8).font('Helvetica')
         .text(termsText, margin + 8, y + 22, { width: leftBoxW - 16, continued: true })
         .text('Here', { continued: true, underline: true, link: w9_link })
         .text(' is our W-9.', { underline: false });

      // ── Totals box (right) ──
      const calcSubtotal = line_items.reduce((s, i) => s + (parseFloat(String(i.amount).replace(/[$,]/g, '')) || (Number(i.quantity) * Number(i.price)) || 0), 0);
      const effectiveSubtotal = subtotal && Number(subtotal) > 0 ? Number(subtotal) : calcSubtotal;
      const embForTotal = strike_embroidery ? 0 : num(embroidery);
      const artForTotal = strike_art ? 0 : artSigned(art_setup);
      const shipForTotal = strike_shipping ? 0 : num(shipping);
      const reimbForTotal = num(sample_reimbursement);
      const customForTotal = num(custom_label);
      const rushForTotal = num(rush_fee);
      const commissionForTotal = num(commission);
      const effectiveTotal = total && Number(total) > 0
        ? Number(total)
        : effectiveSubtotal + shipForTotal + customForTotal + rushForTotal + embForTotal + artForTotal - reimbForTotal - commissionForTotal;
      const qtyTotal = line_items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

      const totRows = [];
      totRows.push(['Subtotal (' + qtyTotal + ')', fmtMoney(effectiveSubtotal), false, false]);
      if (embroidery) totRows.push(['Embroidery', fmtMoney(embroidery), strike_embroidery, false]);
      if (art_setup != null && art_setup !== 0 && art_setup !== '') {
        const artNum = parseFloat(String(art_setup).replace(/[$,\s]/g, ''));
        if (!isNaN(artNum) && artNum !== 0) {
          totRows.push(['Art Setup', artNum < 0 ? `(${fmtMoney(Math.abs(artNum))})` : fmtMoney(artNum), strike_art, false]);
        }
      }
      if (custom_label) totRows.push(['Custom Woven Labels & Hang Tags', fmtMoney(custom_label), false, false]);
      if (num(commission) !== 0) totRows.push(['Commission', commission, false, false]);
      totRows.push(['Shipping', fmtMoney(shipping), strike_shipping, false]);
      if (rush_fee && num(rush_fee) !== 0) totRows.push(['Rush Fee', fmtMoney(rush_fee), false, false]);
      if (num(sample_reimbursement) !== 0) totRows.push(['Sample Reimbursement', sample_reimbursement, false, false]);
      totRows.push(['Total', fmtMoney(effectiveTotal), false, true]);

      const rowH2 = 17;
      const totalsBoxH = totRows.length * rowH2;
      doc.rect(rightBoxX, y, rightBoxW, totalsBoxH).lineWidth(0.75).stroke(LINE);
      let ty = y;
      totRows.forEach(([label, value, strike, bold]) => {
        if (bold) doc.rect(rightBoxX, ty, rightBoxW, rowH2).fill('#f0f0ee').fillColor(INK);
        doc.moveTo(rightBoxX, ty).lineTo(rightBoxX + rightBoxW, ty).lineWidth(0.4).stroke(LINE);
        const labelSize = label.length > 22 ? 7 : 8.5;
        doc.fontSize(labelSize).font('Helvetica-Bold').fillColor(INK)
           .text(label, rightBoxX + 6, ty + (labelSize === 7 ? 6 : 5), { width: rightBoxW * 0.62, lineBreak: false, ellipsis: true });
        doc.fontSize(8.5).font('Helvetica').text(value, rightBoxX + rightBoxW * 0.62, ty + 5, { width: rightBoxW * 0.38 - 8, align: 'right' });
        if (strike) {
          const tw = doc.widthOfString(value);
          const tx = rightBoxX + rightBoxW - 8 - tw;
          const midY = ty + rowH2 / 2;
          doc.moveTo(tx, midY).lineTo(tx + tw, midY).lineWidth(0.8).stroke(INK);
        }
        ty += rowH2;
      });

      // ── FOOTER ──
      doc.moveTo(margin, pageH - 38).lineTo(pageW - margin, pageH - 38).lineWidth(0.75).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(INK)
         .text('Mayor | 870 Inman Village Parkway NE, Suite 533, Atlanta, GA 30307 | 339-206-2111 | mayor@mayorclothing.com',
               margin, pageH - 27, { align: 'center', width: contentW, characterSpacing: 0.5 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderInvoicePdf };
