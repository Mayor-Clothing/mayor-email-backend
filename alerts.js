// Operational alerting: email Marcus when something actually breaks.
//
// Why suppression matters more than sending: on 2026-08-14 a deleted Gmail
// thread made reconcileDrafts fail on EVERY push-driven poll. An un-suppressed
// alerter would have sent hundreds of identical emails in a day, which gets
// muted — and a muted alerter is worse than none. So: one email per distinct
// problem per DEDUPE_MS, plus a hard hourly ceiling.
//
// Best-effort by design — alerting must never break the thing it's watching.

const { sendEmail } = require('./resend');

const ALERT_TO = process.env.ALERT_EMAIL || 'marcusgafford24@gmail.com';
const DEDUPE_MS = 6 * 60 * 60 * 1000; // same problem: at most once per 6h
const MAX_PER_HOUR = 5;               // ceiling across all problems

// Module state. Resets on deploy, which is fine: a restart is exactly when you
// want to hear about a problem again.
const state = { lastSent: new Map(), sentTimes: [] };

// Collapse an error to a stable fingerprint so the same failure recurring is
// recognised as the same failure. Identifiers are masked so they don't defeat
// the dedupe. Gmail thread ids and HubSpot deal ids are HEX, not decimal —
// masking digits alone left the letters behind and every id looked like a
// different problem, which is the exact failure this module exists to prevent.
function fingerprint(context, message) {
  const masked = String(message || '')
    .replace(/\b[0-9a-f]{6,}\b/gi, '#')  // hex ids (Gmail threads, deal ids)
    .replace(/\d+/g, '#');               // any remaining numbers
  return `${context}|${masked.slice(0, 200)}`;
}

// Pure decision, exported for tests. Mutates `s` only when it returns true.
function shouldSend(key, now, s) {
  s.sentTimes = s.sentTimes.filter((t) => now - t < 60 * 60 * 1000);
  if (s.sentTimes.length >= MAX_PER_HOUR) return false;
  const last = s.lastSent.get(key);
  if (last != null && now - last < DEDUPE_MS) return false;
  s.lastSent.set(key, now);
  s.sentTimes.push(now);
  return true;
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// context: short human label of what was running, e.g. "Refresh — regenerate".
// detail: optional extra lines (order number, deal id) to make it actionable.
async function alertError(context, error, detail = {}) {
  try {
    const message = (error && error.message) || String(error);
    if (!shouldSend(fingerprint(context, message), Date.now(), state)) return false;

    const rows = Object.entries(detail)
      .map(([k, v]) => `<tr><td style="padding:2px 10px 2px 0;color:#666;">${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join('');

    await sendEmail({
      to: ALERT_TO,
      subject: `Mayor alert — ${context}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">
        <p><strong>${esc(context)}</strong> failed.</p>
        <p style="background:#f6f6f4;padding:10px;border-radius:6px;font-family:monospace;">${esc(message)}</p>
        ${rows ? `<table style="font-size:13px;">${rows}</table>` : ''}
        <p style="color:#666;font-size:12px;">Repeats of this same problem are suppressed for 6 hours.
        Logs: Render → mayor-email-backend → Logs.</p>
      </div>`,
    });
    return true;
  } catch (e) {
    // Never let alerting break the caller.
    console.error('alert send failed:', e.message);
    return false;
  }
}

module.exports = { alertError, shouldSend, fingerprint };
