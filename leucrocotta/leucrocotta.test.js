// Runnable checks for Leucrocotta's deterministic seam. `node leucrocotta/leucrocotta.test.js`.
const assert = require('assert');
const { parseNickelPaid } = require('./nickelParser');
const { classifyEmail } = require('./emailClassifier');
const { planInboxActions } = require('./leucrocottaService');

// --- nickelParser ---
// Bodies below mirror what gmailClient produces: HTML stripped to one
// whitespace-collapsed line. Subjects/bodies are real Nickel formats.

// Club-name ref, from the subject phrase.
let r = parseNickelPaid({
  subject: 'Processed Card Payment of $1,845.00 for Morris County Golf Club I from Craig Smith Golf Shop LLC',
  text: 'Payment received You received a card payment of $1,845.00 for Morris County Golf Club I from Craig Smith Golf Shop LLC. This payment has been confirmed by the card network. From Craig Smith Golf Shop LLC Payment method American express ···· 1014 Order reference Morris County Golf Club I Est. payout date 07/08/2026',
});
assert.strictEqual(r.isPaid, true);
assert.strictEqual(r.orderNumber, 'Morris County Golf Club I');

// Numeric ref, and the labeled "Order Reference" field in the body.
r = parseNickelPaid({
  subject: 'Processed Card Payment of $3,140.00 for 8901 from Golf Drawn, LLC',
  text: 'Payment Received You received a card payment of $3,140.00 for 8901 from Golf Drawn, LLC. This payment has been confirmed by the card network. Payment ID cmr20mkg201tnur02eyya6zsf Paid To Mayor Clothing LLC Amount Submitted $3,140.00 Order Reference 8901 Payment Method American express ···· 2010',
});
assert.strictEqual(r.isPaid, true);
assert.strictEqual(r.orderNumber, '8901');

// Empty ref ("for  from ...") — paid, but no order number to act on.
r = parseNickelPaid({
  subject: 'Processed ACH Payment of $1,845.00 for  from PIN HUNTERS GOLF LLC',
  text: 'Payment received An ACH payment of $1,845.00 for  from PIN HUNTERS GOLF LLC was submitted and will be sent for processing.',
});
assert.strictEqual(r.isPaid, true);
assert.strictEqual(r.orderNumber, null);

// Bank payout ("You Got Paid") — no order-level ref.
r = parseNickelPaid({
  subject: 'You Got Paid',
  text: 'You Got Paid We just sent payouts totaling $12979.00 to your bank account.',
});
assert.strictEqual(r.isPaid, true);
assert.strictEqual(r.orderNumber, null);

// Not a payment email.
r = parseNickelPaid({ subject: 'Newsletter', text: 'Check out our new styles' });
assert.strictEqual(r.isPaid, false);
assert.strictEqual(r.orderNumber, null);

// --- classifyEmail ---
const opts = { nickelSender: 'support@nickel.com', selfAddresses: ['mayor@mayorclothing.com'] };

assert.strictEqual(
  classifyEmail({
    from: 'Nickel <support@nickel.com>',
    subject: 'Processed Card Payment of $3,140.00 for 8901 from Golf Drawn, LLC',
    text: 'Payment Received You received a card payment of $3,140.00 for 8901 from Golf Drawn, LLC.',
  }, opts),
  'nickel_paid');

// nickel sender but not a paid email => ignore
assert.strictEqual(
  classifyEmail({ from: 'support@nickel.com', subject: 'Your account', text: 'settings changed' }, opts),
  'ignore');

// real customer
assert.strictEqual(
  classifyEmail({ from: 'Coach Dave <dave@club.com>', subject: 'Reorder?', text: 'Can we do 24 more polos?' }, opts),
  'customer_message');

// our own outbound
assert.strictEqual(
  classifyEmail({ from: 'mayor@mayorclothing.com', subject: 'x', text: 'y' }, opts),
  'ignore');

// automated no-reply
assert.strictEqual(
  classifyEmail({ from: 'no-reply@shipping.com', subject: 'Shipped', text: 'tracking' }, opts),
  'ignore');

// --- planInboxActions (the multi-draft fix + adversarial cases) ---
const planOpts = { nickelSender: 'support@nickel.com', selfAddresses: ['mayor@mayorclothing.com'] };

// THE BUG: 5 people on one thread (5 unread messages, same threadId) must
// produce exactly ONE draft, not six — and mark all five read.
const thread = 'T1';
const fivePeople = [1, 2, 3, 4, 5].map((n) => ({
  id: `m${n}`, threadId: thread, internalDate: 1000 + n,
  from: `Person ${n} <p${n}@club.com>`, subject: 'Group order', text: `note ${n}`,
}));
let plan = planInboxActions(fivePeople, planOpts);
assert.strictEqual(plan.draftThreads.length, 1, 'one thread => one draft, not per-message');
assert.strictEqual(plan.draftThreads[0].unreadIds.length, 5, 'all five messages marked read');
assert.strictEqual(plan.draftThreads[0].latestMsg.id, 'm5', 'drafts from the newest message (max internalDate)');

// Two distinct threads => one draft each.
plan = planInboxActions([
  { id: 'a', threadId: 'TA', internalDate: 1, from: 'x@club.com', subject: 's', text: 't' },
  { id: 'b', threadId: 'TB', internalDate: 1, from: 'y@club.com', subject: 's', text: 't' },
], planOpts);
assert.strictEqual(plan.draftThreads.length, 2);

// Mixed batch: a Nickel paid + 2 customer msgs (same thread) + self + no-reply.
plan = planInboxActions([
  { id: 'n', threadId: 'TN', internalDate: 9, from: 'Nickel <support@nickel.com>',
    subject: 'Processed Card Payment of $10.00 for 8901 from X', text: 'Payment received card payment of $10.00 for 8901 from X' },
  { id: 'c1', threadId: 'TC', internalDate: 5, from: 'dave@club.com', subject: 'Reorder', text: 'more?' },
  { id: 'c2', threadId: 'TC', internalDate: 7, from: 'sam@club.com', subject: 'Re: Reorder', text: 'agreed' },
  { id: 's', threadId: 'TS', internalDate: 3, from: 'mayor@mayorclothing.com', subject: 'x', text: 'y' },
  { id: 'nr', threadId: 'TR', internalDate: 4, from: 'no-reply@ups.com', subject: 'Shipped', text: 'tracking' },
], planOpts);
assert.strictEqual(plan.nickelPaid.length, 1, 'nickel routed per-message, not threaded');
assert.strictEqual(plan.draftThreads.length, 1, 'the two customer msgs collapse to one thread');
assert.strictEqual(plan.draftThreads[0].unreadIds.length, 2);
assert.strictEqual(plan.draftThreads[0].latestMsg.id, 'c2');
assert.strictEqual(plan.ignored, 2, 'self + no-reply ignored');

// Empty inbox => nothing to do, no throw.
plan = planInboxActions([], planOpts);
assert.deepStrictEqual([plan.nickelPaid.length, plan.draftThreads.length, plan.ignored], [0, 0, 0]);

console.log('leucrocotta.test.js: all assertions passed');

// --- reconcileDrafts: a dead thread must be retired, not retried forever ---
// Regression: deleted threads threw "Requested entity was not found" on every
// push-driven poll, stayed unreconciled, and re-failed indefinitely.
const { isGoneError } = require('./leucrocottaService');
assert.strictEqual(isGoneError({ code: 404 }), true);
assert.strictEqual(isGoneError({ message: 'Requested entity was not found.' }), true);
assert.strictEqual(isGoneError({ message: 'ECONNRESET' }), false, 'transient errors must still retry');
assert.strictEqual(isGoneError(null), false);
