// Shared OC/Invoice render module.
// Single source of truth for the Order Confirmation / Invoice PDF so the human
// tab (via /generate) and the Hermes agent produce byte-identical output.
// Ported verbatim from the old inline /generate handler — do not "improve" the
// layout math here without re-running the identical-output check (blueprint §13).
//
// Usage:  const pdf = await renderInvoicePdf(data);   // Buffer
// Copy this file + Mayor_Logo_transparent.png together into any repo that needs it.

const PDFDocument = require('pdfkit');
const path = require('path');

const DEFAULT_LOGO_PATH = path.join(__dirname, 'Mayor_Logo_transparent.png');
const DEFAULT_W9 = 'https://drive.google.com/file/d/1iZD_sP2WQbfPrXkHIcPqf7XawDMP2Zi1/view';

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

// data = the /generate payload (see blueprint §5.2). logoPath lets a consuming
// repo point at its own copy of the logo; defaults to the one beside this module.
async function renderInvoicePdf(data, logoPath = DEFAULT_LOGO_PATH) {
  // Pre-fetch product images as buffers (bounded — 5 slots). Mockups are
  // deliberately NOT rendered here: they live on the order page only, so the
  // downloaded document stays lean (and skips five image fetches per render).
  const imageBuffers = await Promise.all(
    (data.line_items || []).map((item, i) => (i < MAX_IMAGES ? fetchImageBuffer(item.url) : null))
  );
  const {
    order_number = '', club = '', address = '', shipping_address = '', ship_date = '',
    date_label = 'Ship Date',
    payment_link = '', payment_link_2 = '', w9_link = DEFAULT_W9,
    line_items = [], subtotal = 0, embroidery, art_setup, strike_embroidery = true, strike_art = true,
    shipping = 0, strike_shipping = false, sample_reimbursement = null,
    custom_label = null, rush_fee = null, payment_terms = '', total = 0
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

      // ── HEADER ──
      const docTitle = data.type === 'confirmation' ? 'Order Confirmation' : 'Invoice';
      doc.fontSize(16).font('Times-Roman')
         .text(docTitle, margin, margin, { align: 'center', width: contentW, characterSpacing: 3 });

      // Logo - no border, just image
      try {
        doc.image(logoPath, pageW - margin - 95, margin - 6, { width: 88 });
      } catch (e) {}

      // Horizontal rule
      doc.moveTo(margin, margin + 30).lineTo(pageW - margin, margin + 30).lineWidth(0.75).stroke('black');

      // ── LAYOUT ──
      const bodyY = margin + 42;
      const leftW = 205;   // wider left column so order number doesn't clip
      const rightX = margin + leftW + 16;
      const rightW = pageW - margin - rightX;

      // ── LEFT COLUMN ──
      let ly = bodyY;

      doc.fontSize(9.5).font('Times-Bold').text('Order Number', margin, ly, { continued: true, width: leftW })
         .font('Times-Roman').text(': ' + order_number, { width: leftW });
      ly += doc.heightOfString('Order Number: ' + order_number, { width: leftW }) + 6;

      const clubLabel = 'Customer';
      doc.font('Times-Bold').text(clubLabel, margin, ly, { continued: true, width: leftW })
         .font('Times-Roman').text(': ', { continued: true });
      if (data.product_page) {
        doc.text(club, { width: leftW, underline: false });
      } else {
        doc.text(club, { width: leftW });
      }
      ly += doc.heightOfString('Customer: ' + club, { width: leftW }) + 10;

      const hasShipping = shipping_address && shipping_address.trim() && shipping_address.trim() !== address.trim();

      doc.font('Times-Bold').text(hasShipping ? 'Billing Address:' : 'Shipping / Billing Address:', margin, ly, { width: leftW });
      ly += 13;

      // Split address on newlines only — launcher handles the formatting
      const addrLines = addressLines(address);
      addrLines.forEach(line => {
        doc.font('Times-Roman').fontSize(9).text(line, margin, ly, { width: leftW });
        // Advance by what the line ACTUALLY occupied. A long line (an address whose
        // parts got joined onto one) wraps to two, and the old fixed 12 printed the
        // next line straight on top of the wrapped remainder.
        ly += Math.max(12, doc.heightOfString(line, { width: leftW }));
      });
      ly += 8;

      if (hasShipping) {
        doc.font('Times-Bold').fontSize(9.5).text('Shipping Address:', margin, ly, { width: leftW });
        ly += 13;
        const shipLines = addressLines(shipping_address);
        shipLines.forEach(line => {
          doc.font('Times-Roman').fontSize(9).text(line, margin, ly, { width: leftW });
          ly += Math.max(12, doc.heightOfString(line, { width: leftW }));
        });
        ly += 8;
      }

      // Skip the row when there's no date — it used to print a bare "Ship Date:".
      if (ship_date && String(ship_date).trim()) {
        doc.fontSize(9.5).font('Times-Bold').text(date_label, margin, ly, { continued: true, width: leftW })
           .font('Times-Roman').text(': ' + ship_date, { width: leftW });
        ly += doc.heightOfString(date_label + ': ' + ship_date, { width: leftW }) + 10;
      }

      doc.font('Times-Bold').text('Payment Terms:', margin, ly, { width: leftW });
      ly += 13;

      const isSplitPayment = !!(payment_link_2 && payment_link_2.trim());
      let termsText;
      if (payment_terms && payment_terms.trim()) {
        // Custom terms from the form — use verbatim, append W-9 reference
        // Only append the boilerplate when the custom terms don't already carry
        // it — some deals have the whole paragraph typed into the field, and
        // appending printed it twice.
        const custom = payment_terms.trim().replace(/\.$/, '');
        termsText = /no returns or exchanges/i.test(custom)
          ? custom + '. '
          : custom + '. Based on our custom model, garments are produced specially for each customer. Once customers approve their order, they are responsible for payment of its full value. There are no returns or exchanges. All sales are final. ';
      } else {
        const leadIn = isSplitPayment ? '50% deposit, 50% on receipt. ' : 'Due on receipt. ';
        termsText = leadIn + 'Based on our custom model, garments are produced specially for each customer. Once customers approve their order, they are responsible for payment of its full value. There are no returns or exchanges. All sales are final. ';
      }
      doc.fontSize(8.5).font('Times-Roman').text(termsText, margin, ly, { width: leftW, continued: true })
         .text('Here', { continued: true, underline: true, link: w9_link })
         .text(' is our W-9.', { underline: false });
      ly += doc.heightOfString(termsText + 'Here is our W-9.', { width: leftW }) + 14;

      if (isSplitPayment) {
        doc.fontSize(9.5).font('Times-Bold').text('Payment Link:', margin, ly, { width: leftW });
        ly += 13;
        doc.fontSize(9).font('Times-Roman')
           .text('50% Deposit', margin, ly, { link: payment_link || '#', underline: true, width: leftW });
        ly += 14;
        doc.fontSize(9).font('Times-Roman')
           .text('50% on Receipt', margin, ly, { link: payment_link_2, underline: true, width: leftW });
      } else {
        doc.fontSize(9.5).font('Times-Bold').text('Payment Link:', margin, ly, { width: leftW });
        ly += 13;
        doc.fontSize(9).font('Times-Roman')
           .text('Click Here', margin, ly, { link: payment_link || '#', underline: true, width: leftW });
      }

      // ── RIGHT COLUMN — TABLE ──
      let ry = bodyY;

      // Product is a text name ~90% of the time (e.g. "Men's Custom Print Polo"),
      // so it gets a text-width column. Widths are tight because this table is
      // only ~300pt wide; the freed mockup width goes to Description.
      const pW = 62;
      const qW = 38;
      const prW = 42;
      const aW = 50;
      const dW = rightW - pW - qW - prW - aW;

      const cP  = rightX;
      const cD  = cP + pW;
      const cQ  = cD + dW;
      const cPr = cQ + qW;
      const cA  = cPr + prW;

      // Header
      const hH = 18;
      doc.rect(rightX, ry, rightW, hH).fill('#1a1a18');
      doc.fillColor('white').fontSize(8.5).font('Times-Bold');
      doc.text('Product',     cP + 3,  ry + 5, { width: pW - 3 });
      doc.text('Description', cD + 3,  ry + 5, { width: dW - 3 });
      doc.text('Quantity',    cQ,       ry + 5, { width: qW,      align: 'right' });
      doc.text('Price',       cPr,      ry + 5, { width: prW,     align: 'right' });
      doc.text('Amount',      cA,       ry + 5, { width: aW - 2,  align: 'right' });
      doc.fillColor('#1a1a18');
      ry += hH;

      // Line items
      line_items.forEach((item, i) => {
        // Normalize description - replace \n with actual newlines, keep spaces intact.
        // sizes are stored in their own column now; re-append them here so the rendered
        // cell is byte-identical to the old merged description (sizes last, \n-joined).
        const descText = [((item.description || '').replace(/\\n/g, '\n').replace(/ \/ /g, '\n')), item.sizes].filter(Boolean).join('\n');
        const imgBuf = imageBuffers[i] || null;
        const imgSize = 52; // thumbnail size in points
        const descH = doc.fontSize(8.5).heightOfString(descText, { width: dW - 8, lineGap: 1.5 });
        const hasDualPrice = item.orig_price && Number(item.orig_price) > 0;
        const prodH = doc.fontSize(8.5).heightOfString(item.product || '', { width: pW - 6 });
        const rowH = Math.max(imgBuf ? imgSize + 10 : 0, descH + 14, prodH + 14, hasDualPrice ? 40 : 26);

        if (i % 2 === 1) {
          doc.rect(rightX, ry, rightW, rowH).fill('#f9f9f8').fillColor('#1a1a18');
        }
        doc.rect(rightX, ry, rightW, rowH).lineWidth(0.4).stroke('#cccccc');

        doc.fontSize(8.5).font('Times-Roman').fillColor('#1a1a18');
        if (imgBuf) {
          try {
            // Fit within the cell preserving aspect ratio (never stretch/squish);
            // centered, so a portrait/landscape mockup keeps its true proportions.
            doc.image(imgBuf, cP + 3, ry + 4, { fit: [pW - 6, rowH - 8], align: 'center', valign: 'center', link: item.product_page || data.product_page || '' });
          } catch (e) {
            doc.text(item.product || '', cP + 3, ry + 7, { width: pW - 6, underline: false });
          }
        } else {
          doc.text(item.product || '', cP + 3, ry + 7, { width: pW - 6, underline: false });
        }
        doc.text(descText, cD + 3, ry + 7, { width: dW - 6, lineGap: 1.5 });
        doc.text(String(item.quantity || ''), cQ,  ry + 7, { width: qW,     align: 'right' });
        // Price column: show orig_price struck through above actual price (stacked)
        if (item.orig_price && Number(item.orig_price) > 0) {
          const origText = fmtMoney(item.orig_price);
          const actText  = fmtMoney(item.price);
          // Draw original price
          doc.text(origText, cPr, ry + 5, { width: prW, align: 'right' });
          const origW = doc.widthOfString(origText);
          const origX = cPr + prW - origW;
          // Strikethrough at true midpoint of font (8.5pt ~= 6px cap height, mid at ~8px from top of text)
          const midY = ry + 5 + 8.5 * 0.35;
          doc.moveTo(origX, midY).lineTo(origX + origW, midY).lineWidth(0.8).stroke('#1a1a18');
          // Draw actual price below
          doc.text(actText, cPr, ry + 18, { width: prW, align: 'right' });
        } else {
          doc.text(item.price ? fmtMoney(item.price) : '', cPr, ry + 7, { width: prW, align: 'right' });
        }
        // Amount column: if orig_price exists, show struck-through orig amount above actual amount
        if (item.orig_price && Number(item.orig_price) > 0) {
          const origAmt = fmtMoney(Number(item.orig_price) * Number(item.quantity));
          const actAmt  = fmtMoney(item.amount);
          doc.text(origAmt, cA, ry + 5, { width: aW - 2, align: 'right' });
          const origAmtW = doc.widthOfString(origAmt);
          const origAmtX = cA + aW - 2 - origAmtW;
          const midY = ry + 5 + 8.5 * 0.35;
          doc.moveTo(origAmtX, midY).lineTo(origAmtX + origAmtW, midY).lineWidth(0.8).stroke('#1a1a18');
          doc.text(actAmt, cA, ry + 18, { width: aW - 2, align: 'right' });
        } else {
          const amtText = item.amount ? fmtMoney(item.amount) : (Number(item.price) === 0 ? fmtMoney(0) : '');
          doc.text(amtText, cA, ry + 7, { width: aW - 2, align: 'right' });
          // Strike through if price is $0
          if (Number(item.price) === 0 && amtText) {
            const tw = doc.widthOfString(amtText);
            const tx = cA + aW - 2 - tw;
            const zMid = ry + 7 + 8.5 * 0.35;
            doc.moveTo(tx, zMid).lineTo(tx + tw, zMid).lineWidth(0.8).stroke('#1a1a18');
          }
          if (Number(item.price) === 0) {
            const prText = fmtMoney(0);
            const ptw = doc.widthOfString(prText);
            const ptx = cPr + prW - ptw;
            const zMid = ry + 7 + 8.5 * 0.35;
            doc.moveTo(ptx, zMid).lineTo(ptx + ptw, zMid).lineWidth(0.8).stroke('#1a1a18');
          }
        }

        ry += rowH;
      });

      // Helper: draw a bottom row with optional strikethrough centered on text
      const drawRow = (label, value, strike = false) => {
        const rH = 17;
        doc.rect(rightX, ry, rightW, rH).lineWidth(0.4).stroke('#cccccc');
        // Labels right-align to the Description column edge so every totals title
        // (Embroidery, Art Setup, Shipping, Rush Fee, Total) lines up under Subtotal.
        doc.fontSize(8.5).font('Times-Bold').fillColor('#1a1a18')
        // A totals row has no quantity cell, so the label gets the full width up to
        // the amount column instead of just the (narrow) description column. Rows
        // are a fixed height: a long label like "Sample Reimbursement" or "Custom
        // Main Label" used to wrap and spill its second line over the row below.
           .text(label, rightX + 3, ry + 5, { width: cA - rightX - 6, align: 'right', lineBreak: false });
        doc.font('Times-Roman').text(value, cA, ry + 5, { width: aW - 2, align: 'right' });
        if (strike) {
          const tw = doc.widthOfString(value);
          const tx = cA + aW - 2 - tw;
          const midY = ry + rH / 2;  // true vertical center of row
          doc.moveTo(tx, midY).lineTo(tx + tw, midY).lineWidth(0.8).stroke('#1a1a18');
        }
        ry += rH;
      };

      // Subtotal row — recalculate from line items if subtotal wasn't passed correctly
      const calcSubtotal = line_items.reduce((s, i) => s + (parseFloat(String(i.amount).replace(/[$,]/g, '')) || (Number(i.quantity) * Number(i.price)) || 0), 0);
      const effectiveSubtotal = subtotal && Number(subtotal) > 0 ? Number(subtotal) : calcSubtotal;
      // Fallback total (only used if a total wasn't passed). Mirrors the generator's rule:
      // shipping, custom label, and non-struck embroidery/art are added; struck fees and
      // the sample reimbursement credit are excluded/subtracted. Art keeps its sign.
      // num() preserves a leading minus sign so art credits stay negative.
      const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,()\s]/g, '')); return isNaN(n) ? 0 : n; };
      const artSigned = (v) => {
        const s = String(v == null ? '' : v).trim();
        const magnitude = num(s);
        // Negative if explicitly signed "-" or wrapped in accounting parentheses "(...)"
        return (s.startsWith('-') || s.startsWith('(')) ? -Math.abs(magnitude) : magnitude;
      };
      const embForTotal = strike_embroidery ? 0 : num(embroidery);
      const artForTotal = strike_art ? 0 : artSigned(art_setup);
      const shipForTotal = strike_shipping ? 0 : num(shipping);
      const reimbForTotal = num(sample_reimbursement); // stored as "(x)" credit
      const customForTotal = num(custom_label);
      const rushForTotal = num(rush_fee);
      const effectiveTotal = total && Number(total) > 0
        ? Number(total)
        : effectiveSubtotal + shipForTotal + customForTotal + rushForTotal + embForTotal + artForTotal - reimbForTotal;

      const qtyTotal = line_items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      doc.rect(rightX, ry, rightW, 17).lineWidth(0.4).stroke('#cccccc');
      doc.fontSize(8.5).font('Times-Bold').fillColor('#1a1a18')
         .text('Subtotal', cD, ry + 5, { width: dW, align: 'right' });
      doc.font('Times-Roman')
         .text(String(qtyTotal), cQ, ry + 5, { width: qW, align: 'right' })
         .text(fmtMoney(effectiveSubtotal), cA, ry + 5, { width: aW - 2, align: 'right' });
      ry += 17;

      if (embroidery) drawRow('Embroidery', fmtMoney(embroidery), strike_embroidery);
      if (art_setup != null && art_setup !== 0 && art_setup !== '') {
        const artNum = parseFloat(String(art_setup).replace(/[$,\s]/g, ''));
        if (!isNaN(artNum) && artNum !== 0) {
          const artDisplay = artNum < 0
            ? `(${fmtMoney(Math.abs(artNum))})`
            : fmtMoney(artNum);
          drawRow('Art Setup', artDisplay, strike_art);
        }
      }
      if (custom_label) drawRow('Custom Main Label', fmtMoney(custom_label));
      drawRow('Shipping', fmtMoney(shipping), strike_shipping);
      if (rush_fee && num(rush_fee) !== 0) drawRow('Rush Fee', fmtMoney(rush_fee));
      // Guard on the NUMBER: the sheet stores "0", which is a truthy string and
      // printed a bare unformatted 0 row.
      if (num(sample_reimbursement) !== 0) drawRow('Sample Reimbursement', sample_reimbursement);

      // Total
      const totH = 18;
      doc.rect(rightX, ry, rightW, totH).lineWidth(0.4).stroke('#cccccc');
      doc.fontSize(9).font('Times-Bold').fillColor('#1a1a18')
         .text('Total', cD, ry + 5, { width: dW, align: 'right' })
         .text(fmtMoney(effectiveTotal), cA, ry + 5, { width: aW - 2, align: 'right' });

      // ── FOOTER ──
      doc.moveTo(margin, pageH - 38).lineTo(pageW - margin, pageH - 38).lineWidth(0.75).stroke();
      doc.fontSize(7).font('Times-Bold').fillColor('#1a1a18')
         .text('Mayor | 870 Inman Village Parkway NE, Suite 533, Atlanta, GA 30307 | 339-206-2111 | mayor@mayorclothing.com',
               margin, pageH - 27, { align: 'center', width: contentW, characterSpacing: 0.5 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderInvoicePdf };
