// Deterministic pre-filter (blueprint §8 "agentic vs code seam"). Decides which
// path an inbound email takes so Claude tokens are spent only on real customer
// language. Pure function — no I/O.
//
// Returns one of: 'nickel_paid' | 'customer_message' | 'ignore'.

const { parseNickelPaid } = require('./nickelParser');

// "Matt Bartini <mayor@x.com>" -> "mayor@x.com". Exact-address extraction so a
// display name like "support@nickel.com <evil@x.com>" can't impersonate a sender.
function extractAddress(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

function senderIs(from, sender) {
  if (!from || !sender) return false;
  return extractAddress(from) === String(sender).trim().toLowerCase();
}

// Gmail stamps Authentication-Results on inbound mail. For the Nickel paid path
// (it flips order status) also require DKIM pass for the sender's domain when
// the header is present; absent header (e.g. unit tests) falls back to the
// exact-address match alone.
function dkimPasses(authResults, senderDomain) {
  if (!authResults) return true;
  const a = String(authResults).toLowerCase();
  return /dkim=pass/.test(a) && a.includes(senderDomain.toLowerCase());
}

// Machine/no-reply senders we never draft a human reply to.
const AUTOMATED = [
  /no-?reply/i, /do-?not-?reply/i, /notifications?@/i, /mailer-daemon/i,
  /postmaster@/i, /@.*\.hubspot/i, /calendar-notification/i, /automated/i,
  // loop-fix (added 2026-07-29): carrier tracking / shipping-partner billing
  // senders. Root cause of the 2026-07-21/22 loop — mcinfo@ups.com matched
  // NONE of the patterns above, so every UPS tracking update was classified
  // as 'customer_message' and Leucrocotta drafted + "learned" from it
  // repeatedly (each update is a new thread, so the hasDraft guard in
  // leucrocottaService.js never caught it either). Adding known carrier and
  // shipping-billing domains here so this can't recur for these senders;
  // leucrocottaService.js also has a generic per-sender burst cap as a
  // backstop for senders not yet on this list.
  /@ups\.com$/i,
  /@fedex\.com$/i,
  /@usps\.com$/i,
  /@dhl\.com$/i,
  /^(billing|mailer)@shopify\.com$/i,
  /@pnc\.com$/i,
];

// { from, subject, text, authResults }, opts { nickelSender, selfAddresses: [] }
function classifyEmail({ from = '', subject = '', text = '', authResults = '' } = {}, opts = {}) {
  const { nickelSender = '', selfAddresses = [] } = opts;

  // Our own outbound / bounces — never act.
  if (selfAddresses.some((self) => senderIs(from, self))) return 'ignore';

  // Nickel payment notification -> deterministic paid path. Exact envelope
  // address + DKIM (when available) — display-name spoofing must not reach here.
  if (senderIs(from, nickelSender)) {
    const domain = String(nickelSender).split('@')[1] || '';
    if (!dkimPasses(authResults, domain)) return 'ignore';
    const { isPaid } = parseNickelPaid({ subject, text });
    return isPaid ? 'nickel_paid' : 'ignore';
  }

  // Other automated senders -> ignore (nothing to draft).
  if (AUTOMATED.some((re) => re.test(from))) return 'ignore';

  // A human wrote something -> Claude drafting path.
  if (from) return 'customer_message';
  return 'ignore';
}

module.exports = { classifyEmail, extractAddress };
