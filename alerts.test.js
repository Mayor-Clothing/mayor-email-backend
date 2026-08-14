// Runnable checks for alert suppression. `node alerts.test.js`.
// The whole point of this module is NOT sending, so that's what's tested.
const assert = require('assert');
const { shouldSend, fingerprint } = require('./alerts');

const HOUR = 60 * 60 * 1000;
const fresh = () => ({ lastSent: new Map(), sentTimes: [] });

// First occurrence sends.
let s = fresh();
assert.strictEqual(shouldSend('a', 0, s), true);

// The same problem again is suppressed for 6 hours, then allowed.
assert.strictEqual(shouldSend('a', HOUR, s), false, 'duplicate within 6h must be suppressed');
assert.strictEqual(shouldSend('a', 5 * HOUR, s), false);
assert.strictEqual(shouldSend('a', 7 * HOUR, s), true, 'after 6h the same problem may alert again');

// A different problem is not suppressed by the first one.
s = fresh();
assert.strictEqual(shouldSend('a', 0, s), true);
assert.strictEqual(shouldSend('b', 0, s), true);

// Hourly ceiling: 5 distinct problems send, the 6th does not.
s = fresh();
for (let i = 0; i < 5; i++) assert.strictEqual(shouldSend(`k${i}`, 0, s), true);
assert.strictEqual(shouldSend('k5', 0, s), false, 'hourly cap must hold');
// ...and the ceiling lifts once the hour has rolled past.
assert.strictEqual(shouldSend('k5', HOUR + 1, s), true);

// The real-world case this exists for: reconcileDrafts looping on deleted
// threads. Different ids, same failure -> ONE email, not hundreds.
const a = fingerprint('Leucrocotta — reconcile', 'reconcile 19f8f1a0fc61140b failed: Requested entity was not found.');
const b = fingerprint('Leucrocotta — reconcile', 'reconcile 19f90074cec23c3a failed: Requested entity was not found.');
assert.strictEqual(a, b, 'ids must not defeat the dedupe');

// But a genuinely different failure in the same area still gets through.
const c = fingerprint('Leucrocotta — reconcile', 'reconcile 19f9 failed: quota exceeded');
assert.notStrictEqual(a, c);

console.log('alerts.test.js: all assertions passed');
