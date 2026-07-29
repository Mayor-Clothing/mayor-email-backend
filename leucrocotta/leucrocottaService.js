// Leucrocotta orchestration: poll the inbox, classify each unread message, and
// dispatch. Nickel "paid" -> flip MO status to Pending (deterministic). Customer
// message -> draft a reply in Mayor's voice for Matt to review, accrue memory.

const { config } = require('../config');
const { markPaid } = require('../hermesService');
const { classifyEmail, extractAddress } = require('./emailClassifier');
const { parseNickelPaid } = require('./nickelParser');
const gmail = require('./gmailClient');
const memory = require('./driveMemory');
const drafter = require('./voiceDrafter');

const NICKEL_SENDER = process.env.NICKEL_SENDER || 'support@nickel.com';

// --- loop-fix (added 2026-07-29) -------------------------------------------
// Root cause of the 2026-07-21/22 UPS loop: an automated notification sender
// (mcinfo@ups.com) got classified as 'customer_message'. Because UPS sends
// each update as a NEW thread rather than a reply, the hasDraft guard in
// handleCustomerThread() never caught it — every notification looked like a
// brand-new customer email. Leucrocotta drafted + reconciled against each one
// repeatedly, which is how ~140 near-duplicate entries ended up in voice.md's
// calibration log.
//
// Two independent, defensive guards below (kept in this file rather than
// emailClassifier.js so they apply regardless of how classifyEmail evolves):
//   1. AUTOMATED_SENDER_PATTERNS — known notification/billing senders are
//      never treated as customer messages, even if misclassified upstream.
//   2. Per-poll per-sender cap — if the SAME sender produces more than
//      MAX_THREADS_PER_SENDER_PER_POLL distinct threads in one poll (a
//      notification system misbehaving, or a future mis-threaded loop from
//      an address not on the known list), the extras are flagged for human
//      review instead of drafted blindly.
const AUTOMATED_SENDER_PATTERNS = [
  /@ups\.com$/i,
  /@fedex\.com$/i,
  /@usps\.com$/i,
  /(^|@)mailer\.shopify\.com$/i,
  /^billing@shopify\.com$/i,
  /^mailer@shopify\.com$/i,
  /@pnc\.com$/i,
  /^notifications-noreply@linkedin\.com$/i,
  /^no-?reply/i,
  /^donotreply/i,
  /^do-?not-?reply/i,
];

function isAutomatedSender(address = '') {
  const addr = address.trim().toLowerCase();
  return AUTOMATED_SENDER_PATTERNS.some((re) => re.test(addr));
}

const MAX_THREADS_PER_SENDER_PER_POLL = 3;
// -----------------------------------------------------------------------

async function handleNickelPaid(msg) {
  const { orderNumber } = parseNickelPaid(msg);
  if (!orderNumber) return { action: 'nickel_paid', skipped: 'no order number parsed' };
  const res = await markPaid(orderNumber);
  // If the order isn't in the sheet, the payment can't be tied to anything —
  // leave the email UNREAD so it isn't silently lost (a human reconciles). Any
  // other outcome (marked paid, or already past Pending) is handled: mark read.
  if (res.skipped === 'order not found') {
    return { action: 'nickel_paid', orderNumber, statusUpdated: false, skipped: 'order not found — left unread' };
  }
  await gmail.markRead(msg.id);
  return { action: 'nickel_paid', orderNumber, statusUpdated: !!res.updated };
}

// Pure planner (no I/O) — the fix for "6 drafts on one thread". Classifies each
// unread message, routes Nickel-paid per-message, and collapses customer
// messages to ONE draft per THREAD (drafting from the latest message, marking
// every unread message in that thread read). Exported for adversarial tests.
function planInboxActions(messages, { nickelSender = '', selfAddresses = [] } = {}) {
  const nickelPaid = [];
  const threads = new Map(); // threadId -> { latestMsg, unreadIds: [] }
  let ignored = 0;
  for (const msg of messages) {
    const kind = classifyEmail(msg, { nickelSender, selfAddresses });
    if (kind === 'nickel_paid') { nickelPaid.push(msg); continue; }

    // loop-fix guard: known automated/notification senders are never drafted
    // to, regardless of what the classifier decided (see block comment above).
    const fromAddr = extractAddress(msg.from);
    if (isAutomatedSender(fromAddr) || selfAddresses.includes(fromAddr)) { ignored += 1; continue; }

    if (kind !== 'customer_message') { ignored += 1; continue; }
    const t = threads.get(msg.threadId) || { latestMsg: null, unreadIds: [] };
    t.unreadIds.push(msg.id);
    if (!t.latestMsg || (msg.internalDate || 0) >= (t.latestMsg.internalDate || 0)) t.latestMsg = msg;
    threads.set(msg.threadId, t);
  }

  // loop-fix guard: cap distinct threads drafted per sender in a single poll.
  // Anything past the cap is flagged for human review instead of drafted.
  const seenPerSender = new Map();
  const draftThreads = [];
  const flaggedForReview = [];
  for (const [threadId, t] of threads.entries()) {
    const fromAddr = extractAddress(t.latestMsg.from);
    const count = (seenPerSender.get(fromAddr) || 0) + 1;
    seenPerSender.set(fromAddr, count);
    if (count > MAX_THREADS_PER_SENDER_PER_POLL) {
      flaggedForReview.push({ threadId, fromAddr });
      continue;
    }
    draftThreads.push({ threadId, latestMsg: t.latestMsg, unreadIds: t.unreadIds });
  }

  return { nickelPaid, draftThreads, ignored, flaggedForReview };
}

// Draft ONE reply for a whole thread. Skips (but marks read) if the thread
// already holds a draft — ours from a prior poll or one Matt is composing — so
// we never stack drafts on a conversation.
async function handleCustomerThread({ threadId, latestMsg, unreadIds }) {
  if (!drafter.enabled()) return { action: 'customer_message', threadId, skipped: 'no ANTHROPIC_API_KEY' };

  const { text: threadText, hasDraft } = await gmail.getThread(threadId);
  if (hasDraft) {
    for (const id of unreadIds) await gmail.markRead(id);
    return { action: 'customer_message', threadId, skipped: 'thread already has a draft' };
  }

  const customerEmail = extractAddress(latestMsg.from);
  const [voice, knowledge, contactMemory] = await Promise.all([
    memory.readVoice(),
    memory.readKnowledge(),
    memory.readContactMemory(customerEmail),
  ]);

  const body = await drafter.draftReply({ threadText: threadText || latestMsg.text, voice, knowledge, contactMemory, customerEmail });
  if (!body) return { action: 'customer_message', threadId, skipped: 'empty draft' };

  const subject = /^re:/i.test(latestMsg.subject) ? latestMsg.subject : `Re: ${latestMsg.subject}`;
  await gmail.createDraft({ threadId, to: customerEmail, subject, body });
  // Mark EVERY unread message in the thread read — not just one — so a sibling
  // message doesn't trigger another draft on the next poll.
  for (const id of unreadIds) await gmail.markRead(id);

  const note = `\n- ${new Date().toISOString().slice(0, 10)}: replied re "${latestMsg.subject}"`;
  await memory.writeContactMemory(customerEmail, (contactMemory || `# ${customerEmail}\n`) + note);

  try {
    const log = await memory.readDraftLog();
    log.push({ threadId, customerEmail, subject, draftBody: body, createdMs: Date.now(), reconciled: false });
    await memory.writeDraftLog(log);
  } catch (e) { console.error('draft-log write failed:', e.message); }

  return { action: 'customer_message', threadId, customerEmail, drafted: true };
}


// Learning loop: for each recorded draft, once Matt has SENT his own reply in the
// thread, compare draft vs. sent and fold the lessons into voice + contact memory.
// Fully guarded and best-effort — never throws into the poll. Drops entries once
// reconciled, and prunes anything older than 30 days.
async function reconcileDrafts() {
  if (!drafter.enabled() || !memory.enabled()) return { reconciled: 0 };
  const log = await memory.readDraftLog();
  if (!log.length) return { reconciled: 0 };

  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const rec of log) {
    if (rec.reconciled) continue;
    try {
      const sent = await gmail.getSentReplyInThread(rec.threadId, rec.createdMs);
      if (!sent || !sent.text) continue; // Matt hasn't sent his reply yet

      const threadText = await gmail.getThreadText(rec.threadId);
      const { voiceLesson, contactLesson } = await drafter.learnFromReply({
        threadText, draftBody: rec.draftBody, sentBody: sent.text,
      });

      if (voiceLesson) {
        const voice = await memory.readVoice();
        await memory.writeVoice(`${voice || "# Mayor — Matt's Email Voice"}\n- (learned ${today}): ${voiceLesson}`);
      }
      if (contactLesson) {
        const cm = await memory.readContactMemory(rec.customerEmail);
        await memory.writeContactMemory(rec.customerEmail, `${cm || `# ${rec.customerEmail}`}\n- ${today}: ${contactLesson}`);
      }
      rec.reconciled = true;
      count += 1;
    } catch (e) { console.error(`reconcile ${rec.threadId} failed:`, e.message); }
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const remaining = log.filter((r) => !r.reconciled && r.createdMs > cutoff);
  if (remaining.length !== log.length) await memory.writeDraftLog(remaining);
  return { reconciled: count };
}

// Single-flight guard: Gmail push can fire several times in quick succession,
// and two concurrent polls would each process the same unread mail and double-
// draft. Only one poll runs at a time; overlapping triggers are dropped (the
// next real change re-fires anyway).
let polling = false;

async function runInboxPoll() {
  if (!gmail.enabled()) return { skipped: 'gmail not configured', results: [] };
  if (polling) return { skipped: 'poll already in progress', results: [] };
  polling = true;
  try {
    const selfAddresses = [gmail.GMAIL_USER, config.resend.fromEmail].filter(Boolean);
    const refs = await gmail.listUnreadInbound();

    const messages = [];
    for (const ref of refs) {
      try { messages.push(await gmail.getMessage(ref.id)); }
      catch (e) { console.error('Leucrocotta getMessage failed:', e.message); }
    }

    const { nickelPaid, draftThreads, flaggedForReview } = planInboxActions(messages, { nickelSender: NICKEL_SENDER, selfAddresses });
    if (flaggedForReview && flaggedForReview.length) {
      console.warn(`Leucrocotta: ${flaggedForReview.length} thread(s) exceeded the per-sender draft cap this poll — left for human review`, flaggedForReview);
    }
    const results = [];

    for (const msg of nickelPaid) {
      try { results.push(await handleNickelPaid(msg)); }
      catch (e) { console.error('Leucrocotta nickel failed:', e.message); results.push({ action: 'error', error: e.message }); }
    }
    for (const t of draftThreads) {
      try { results.push(await handleCustomerThread(t)); }
      catch (e) { console.error('Leucrocotta draft failed:', e.message); results.push({ action: 'error', error: e.message }); }
    }

    let reconciled = 0;
    try { reconciled = (await reconcileDrafts()).reconciled; } catch (e) { console.error('reconcile pass failed:', e.message); }

    return { skipped: null, results, reconciled };
  } finally {
    polling = false;
  }
}

module.exports = { runInboxPoll, planInboxActions, handleNickelPaid, handleCustomerThread, reconcileDrafts, isAutomatedSender };
