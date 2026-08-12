const express = require('express');
const { config, assertConfigured } = require('./config');
const { generateDocument, runPoll, refreshModifiedDeals } = require('./hermesService');
const { requireInternalAuth } = require('./internalAuth');

const router = express.Router();

// POST /hermes/generate  { dealId, docType: 'order_confirmation'|'invoice' }
// Renders the OC/Invoice PDF from live HubSpot deal props, persists to Drive +
// MO sheet, and returns the PDF (base64) plus the computed status.
router.post('/generate', requireInternalAuth, async (req, res, next) => {
  try {
    const { dealId, docType } = req.body || {};
    if (!dealId) return res.status(400).json({ error: 'dealId is required' });
    if (docType !== 'order_confirmation' && docType !== 'invoice') {
      return res.status(400).json({ error: "docType must be 'order_confirmation' or 'invoice'" });
    }

    assertConfigured(['hubspot.token']);

    const idempotencyKey = req.header('X-Idempotency-Key');
    const result = await generateDocument({ dealId, docType, idempotencyKey });

    const body = { ...result };
    if (result.pdf) { body.pdfBase64 = result.pdf.toString('base64'); delete body.pdf; }
    res.status(200).json(body);
  } catch (error) {
    next(error);
  }
});

// POST /hermes/poll — safety-net reconcile of trigger flags. Wire a Render cron
// (hourly) to hit this. Idempotency keeps it cheap alongside the webhook path.
router.post('/poll', requireInternalAuth, async (_req, res, next) => {
  try {
    // Cron hits this hourly. Stay green (200 skipped) until HubSpot is wired up,
    // so a red cron always means a real failure — not "not configured yet".
    if (!config.hubspot.token) {
      return res.status(200).json({ ok: true, skipped: 'hubspot not configured' });
    }
    const counts = await runPoll();
    res.status(200).json({ ok: true, counts });
  } catch (error) {
    next(error);
  }
});

// POST /hermes/refresh — the public "Refresh" button on mayor-tools. NO internal
// key: the button lives on a public GitHub Pages site so it can't hold one. Safe
// because it only re-syncs the sheet to match current HubSpot (nothing
// destructive or exfiltrating). Rate-limited to blunt accidental/abusive spam.
const _refreshHits = new Map();
function refreshRateLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const rec = _refreshHits.get(ip);
  if (!rec || now > rec.reset) { _refreshHits.set(ip, { n: 1, reset: now + 60000 }); return next(); }
  if (++rec.n > 6) return res.status(429).json({ error: 'Too many refreshes — wait a minute.' });
  next();
}

router.post('/refresh', refreshRateLimit, (req, res) => {
  // Respond right away so closing the tab can't cancel the work; the reconcile
  // runs in the background. Matt clicks and x's out — that's the intended flow.
  res.status(202).json({ ok: true, message: 'Refresh received — Hermes is checking HubSpot for edits.' });
  refreshModifiedDeals()
    .then((s) => console.log('refresh done:', JSON.stringify(s)))
    .catch((e) => console.error('refresh failed:', e.message));
});

module.exports = router;
