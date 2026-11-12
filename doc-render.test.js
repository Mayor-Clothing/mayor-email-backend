// Renders sample invoices with the shared PDF renderer and checks the basics:
// it produces a PDF, small orders stay on one page, big orders flow onto more pages
// instead of overflowing, and the odd payment/address shapes don't throw.
// Run: node doc-render.test.js   (no network: no product has an image URL)
const assert = require('assert');
const { renderInvoicePdf } = require('./doc-render');

const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
const item = (n, extra = {}) => ({
  product: 'Men’s Custom Print Polo', description: 'Colorway: Navy\nEmbroidery (Left Chest): Club Logo in Navy\nEmbroidery (Right Sleeve): "TRIM PACKAGE TEAM" in British Grey (0.1866in x 3in)',
  sizes: 'S: 2 - M: 4 - L: 12 - XL: 12', quantity: 10 + n, price: 56, orig_price: 64, amount: (10 + n) * 56, ...extra,
});
const base = {
  order_number: 'TEST I', club: 'Test Club', invoice_date: 'November 12, 2026', ship_date: 'December 1, 2026',
  address: 'Test Club\nAttn: Pat Smith\n1 Main St\nTown, GA 30000', payment_link: 'https://mayorclothingllc.nickelpayments.com/pay/abc12345',
  shipping: 50, total: 0,
};

(async () => {
  const one = await renderInvoicePdf({ ...base, line_items: [item(1)] });
  assert.strictEqual(one.slice(0, 4).toString(), '%PDF', 'produces a PDF');
  assert.strictEqual(pages(one), 1, 'a one-product invoice is one page');

  const three = await renderInvoicePdf({ ...base, line_items: [item(1), item(2), item(3)] });
  assert.strictEqual(pages(three), 1, 'a three-product invoice is still one page');

  const six = await renderInvoicePdf({ ...base, line_items: [1, 2, 3, 4, 5, 6].map((n) => item(n)) });
  assert.ok(pages(six) >= 2, 'a six-product invoice flows onto a second page instead of overflowing');

  // Two different addresses go in one box and stay on one page for a normal order.
  const twoAddr = await renderInvoicePdf({ ...base, shipping_address: 'Other Place\n2 Side St\nCity, GA 30001', line_items: [item(1), item(2)] });
  assert.strictEqual(pages(twoAddr), 1, 'two addresses in one box, normal order stays on one page');

  // A description longer than a whole page flows across pages and still finishes with the totals.
  const longDesc = Array.from({ length: 70 }, (_, i) => 'Placement ' + (i + 1) + ': custom crest in navy with metallic gold thread outline, matching the approved mockup').join('\n');
  const huge = await renderInvoicePdf({ ...base, line_items: [item(1, { description: longDesc }), item(2)] });
  assert.ok(pages(huge) >= 3, 'a very long description runs across several pages');

  // Odd payment shapes: plain text, two links, none -- none may throw.
  for (const pay of [{ payment_link: 'Paid by check #1042 / received Nov 3' },
    { payment_link: 'https://mayorclothingllc.nickelpayments.com/pay/a', payment_link_2: 'https://mayorclothingllc.nickelpayments.com/pay/b' },
    { payment_link: '' }]) {
    const b = await renderInvoicePdf({ ...base, ...pay, line_items: [item(1)] });
    assert.strictEqual(pages(b), 1, 'payment variants stay on one page');
  }

  // Legacy / sparse data: no order number, no date, no products must not throw.
  await renderInvoicePdf({ line_items: [] });
  await renderInvoicePdf({ ...base, order_number: '', invoice_date: '', ship_date: '', line_items: [item(1, { quantity: 0, price: 0, amount: 0, orig_price: null })] });

  console.log('doc-render.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
