// Hermes core: generate a document from a HubSpot deal, and the status
// transitions. Shared by the HTTP route, the webhook fast-path, and the poll.

const { getInvoiceDeal, searchDeals, clearDealTrigger, setDealOrderStatus } = require('./hubspot');
const { dealToRenderPayload, INVOICE_PROPERTIES, statusToValue } = require('./hermesMapping');
const { renderInvoicePdf } = require('./doc-render');
const { persistOrder, setOrderStatus, dealDocPresence } = require('./googleStore');

// Trigger property names (blueprint §4.3). Created manually in HubSpot; until
// then triggers simply never fire and the poll's searches no-op.
const TRIGGER = {
  oc: 'zc_trigger_oc',
  invoice: 'zd_trigger_invoice',
  tracking: 'zg_tracking_number',
  delivered: 'zf_delivered_date',
};

// Short-window dedup so a webhook and a near-simultaneous poll don't double-run
// the SAME trigger. Deliberately time-boxed (NOT permanent): an intentional
// re-trigger later — Matt re-checks "Send Order Confirmation" to push a HubSpot
// edit into the sheet/PDF — must actually regenerate. The backstop against the
// hourly poll re-firing is clearDealTrigger clearing the checkbox after each run
// (needs deals-write scope on the private app).
const DEDUP_TTL_MS = 2 * 60 * 1000;
const seenAt = new Map(); // key -> last-generated epoch ms

// docType: 'order_confirmation' | 'invoice'
// skipClearTrigger: don't PATCH the deal's trigger checkbox afterward — used by
// the refresh reconcile so it never bumps hs_lastmodifieddate (which would make
// the deal look "edited" and re-loop on the next refresh).
async function generateDocument({ dealId, docType, idempotencyKey, skipClearTrigger }) {
  const deal = await getInvoiceDeal(dealId, INVOICE_PROPERTIES);
  const payload = dealToRenderPayload(deal, docType);
  const orderNumber = payload.order_number;

  // Blueprint §6.1: an invoice only generates once a payment link is present.
  // Log it loudly rather than skipping silently — otherwise the customer just
  // sees "Invoice not available yet" forever with nobody knowing a missing link
  // is the blocker (F6).
  if (docType === 'invoice' && !payload.payment_link) {
    console.warn(`Invoice NOT generated for deal ${dealId} (order "${orderNumber}"): no payment link. Set y_payment_link in HubSpot, then re-trigger the invoice.`);
    return { ok: false, docType, orderNumber, skipped: 'no payment link' };
  }

  const key = idempotencyKey || `${orderNumber}:${docType}`;
  const last = seenAt.get(key);
  if (last && Date.now() - last < DEDUP_TTL_MS) {
    return { ok: true, docType, orderNumber, skipped: true };
  }

  const pdf = await renderInvoicePdf(payload);
  const persist = await persistOrder({ payload, docType, pdfBuffer: pdf });
  seenAt.set(key, Date.now());

  // Clear the trigger checkbox now that this doc exists, so the hourly poll
  // stops re-generating it every run (best-effort: needs deals-write scope on
  // the private app; a failure just leaves the old, slower behavior).
  if (!skipClearTrigger && persist.persisted && dealId) {
    const trigger = docType === 'invoice' ? TRIGGER.invoice : TRIGGER.oc;
    try { await clearDealTrigger(dealId, trigger); }
    catch (e) { console.error(`clearDealTrigger ${trigger} for deal ${dealId} failed:`, e.message); }
  }

  return {
    ok: true,
    docType,
    orderNumber,
    status: persist.status,
    driveFileId: persist.driveFileId,
    pdfUrl: persist.pdfUrl,
    persisted: persist.persisted,
    pdf, // Buffer; the HTTP route base64-encodes it, triggers ignore it
  };
}

async function markInTransit(dealId) {
  const deal = await getInvoiceDeal(dealId, ['order_number', TRIGGER.tracking]);
  const p = deal.properties || {};
  const res = await setOrderStatus({ orderNumber: p.order_number, status: 'In Transit', tracking: p[TRIGGER.tracking] });
  // Mirror the status onto the HubSpot dropdown so it matches the sheet.
  try { await setDealOrderStatus(dealId, statusToValue('In Transit')); }
  catch (e) { console.error(`setDealOrderStatus In Transit for deal ${dealId} failed:`, e.message); }
  return res;
}


// The delivered trigger (zf_delivered_date = "In Hand Date") is a PLANNED date.
// Only mark an order Delivered once that date is today or already past — never on
// a future date. HubSpot date props come back as midnight-UTC epoch millis.
function inHandReached(v) {
  if (v == null || String(v).trim() === '') return false;
  const str = String(v).trim();
  const ms = /^\d+$/.test(str) ? Number(str) : new Date(str).getTime();
  if (isNaN(ms)) return false;
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return ms <= todayUTC;
}

async function markDelivered(dealId) {
  const deal = await getInvoiceDeal(dealId, ['order_number', TRIGGER.delivered]);
  const p = deal.properties || {};
  if (!inHandReached(p[TRIGGER.delivered])) {
    return { action: 'delivered', orderNumber: p.order_number, skipped: 'in hand date is in the future' };
  }
  const res = await setOrderStatus({ orderNumber: p.order_number, status: 'Delivered', deliveredDate: p[TRIGGER.delivered] });
  // Mirror the status onto the HubSpot dropdown so it matches the sheet.
  try { await setDealOrderStatus(dealId, statusToValue('Delivered')); }
  catch (e) { console.error(`setDealOrderStatus Delivered for deal ${dealId} failed:`, e.message); }
  return res;
}

// Status is manual now — Matt sets "In Progress" after payment. A Nickel "paid"
// event no longer auto-changes the order status. Kept as a no-op so Leucrocotta's
// call site doesn't break.
async function markPaid(orderNumber) {
  return { updated: false, status: null, skipped: 'order status is manual now' };
}

// Pure: map a HubSpot webhook event -> an action. Returns null for irrelevant events.
function classifyTriggerEvent(event) {
  if (event?.subscriptionType !== 'deal.propertyChange') return null;
  const dealId = String(event.objectId);
  const val = event.propertyValue;
  const isTrue = val === true || val === 'true';
  const isSet = val != null && String(val).trim() !== '';
  switch (event.propertyName) {
    case TRIGGER.oc:        return isTrue ? { action: 'generate_oc', dealId } : null;
    case TRIGGER.invoice:   return isTrue ? { action: 'generate_invoice', dealId } : null;
    case TRIGGER.tracking:  return isSet ? { action: 'in_transit', dealId } : null;
    case TRIGGER.delivered: return isSet ? { action: 'delivered', dealId } : null;
    default: return null;
  }
}

// Run one classified action. Central dispatch used by webhook + poll.
async function runAction({ action, dealId }) {
  switch (action) {
    case 'generate_oc':      return generateDocument({ dealId, docType: 'order_confirmation' });
    case 'generate_invoice': return generateDocument({ dealId, docType: 'invoice' });
    case 'in_transit':       return markInTransit(dealId);
    case 'delivered':        return markDelivered(dealId);
    default: return null;
  }
}

// Safety-net poll: reconcile deals whose trigger flags are set. Idempotency +
// the "no payment link" / "already generated" guards make repeats cheap. Each
// search is isolated so a not-yet-created property can't sink the whole run.
async function runPoll() {
  const counts = { generate_oc: 0, generate_invoice: 0, in_transit: 0, delivered: 0, errors: 0 };

  const scan = async (filter, action) => {
    try {
      const deals = await searchDeals([{ filters: [filter] }], ['order_number']);
      for (const d of deals) {
        try { await runAction({ action, dealId: d.id }); counts[action] += 1; }
        catch (e) { counts.errors += 1; console.error(`poll ${action} deal ${d.id}:`, e.message); }
      }
    } catch (e) {
      // Property likely not created yet — expected before manual HubSpot config.
      console.warn(`poll scan ${action} skipped:`, e.message);
    }
  };

  await scan({ propertyName: TRIGGER.oc, operator: 'EQ', value: 'true' }, 'generate_oc');
  await scan({ propertyName: TRIGGER.invoice, operator: 'EQ', value: 'true' }, 'generate_invoice');
  await scan({ propertyName: TRIGGER.tracking, operator: 'HAS_PROPERTY' }, 'in_transit');
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  await scan({ propertyName: TRIGGER.delivered, operator: 'LTE', value: String(todayUTC) }, 'delivered');

  return counts;
}

// Manual "Refresh" button (mayor-tools). Re-sync deals edited in HubSpot since
// the last refresh, so a HubSpot change lands on the sheet WITHOUT the button
// knowing which deal it was — the deal's own hs_lastmodifieddate is the signal.
// Only regenerates docs that ALREADY exist for the deal (update, never create a
// premature OC/Invoice for a deal that was merely edited mid-stage), and never
// PATCHes the deal (skipClearTrigger) so a refresh can't loop back on itself.
let lastRefreshTs = Date.now() - 24 * 60 * 60 * 1000; // cold start: cover the last 24h
// HubSpot's search index lags behind writes by seconds to minutes. Without an
// overlap, an edit made just before a click isn't indexed yet, the window still
// advances past it, and NO later click will ever pick it up — the button looks
// like it "doesn't work sometimes". Re-examining a few extra minutes is cheap:
// regenerating a doc is an upsert.
const REFRESH_GRACE_MS = 10 * 60 * 1000;
let lastRefreshSummary = null;
const getLastRefreshSummary = () => lastRefreshSummary;

async function refreshModifiedDeals() {
  const runId = Date.now();
  const since = lastRefreshTs - REFRESH_GRACE_MS;
  const summary = { checked: 0, regenerated: [], errors: 0 };
  let deals;
  try {
    deals = await searchDeals(
      [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(since) }] }],
      ['order_number'],
    );
  } catch (e) {
    console.error('refresh searchDeals failed:', e.message);
    return { ...summary, error: e.message };
  }
  lastRefreshTs = Date.now();
  summary.checked = deals.length;
  for (const d of deals) {
    const orderNumber = (d.properties && d.properties.order_number) || '';
    let presence;
    try { presence = await dealDocPresence({ dealId: d.id, orderNumber }); }
    catch (e) { summary.errors += 1; console.error(`refresh presence ${d.id}:`, e.message); continue; }
    for (const docType of ['order_confirmation', 'invoice']) {
      if (!(docType === 'invoice' ? presence.invoice : presence.oc)) continue;
      try {
        // Unique key per run: the 2-minute dedup exists to stop a webhook and a
        // poll double-firing, but it must never swallow an explicit human click
        // (the "it didn't work, click it again" retry landed inside that window).
        await generateDocument({ dealId: d.id, docType, skipClearTrigger: true, idempotencyKey: `refresh:${runId}:${d.id}:${docType}` });
        summary.regenerated.push(`${orderNumber || d.id}:${docType === 'invoice' ? 'inv' : 'oc'}`);
      } catch (e) { summary.errors += 1; console.error(`refresh regen ${d.id} ${docType}:`, e.message); }
    }
  }
  lastRefreshSummary = { ...summary, finishedAt: new Date().toISOString(), windowStart: new Date(since).toISOString() };
  return summary;
}

module.exports = { generateDocument, markInTransit, markDelivered, markPaid, classifyTriggerEvent, runAction, runPoll, refreshModifiedDeals, getLastRefreshSummary, TRIGGER };
