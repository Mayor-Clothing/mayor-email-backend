// Covers the two reasons the Refresh button "didn't work every time":
//   1. the search window advanced past edits HubSpot hadn't indexed yet
//   2. the 2-minute dedup swallowed the user's "click it again" retry
//
// Stubs hubspot/googleStore BEFORE requiring hermesService, which destructures
// their exports at load time.
const assert = require('assert');
const path = require('path');

const hubspot = require('./hubspot');
const googleStore = require('./googleStore');
const docRender = require('./doc-render');

const searches = [];
hubspot.searchDeals = async (filterGroups) => {
  searches.push(Number(filterGroups[0].filters[0].value));
  return [{ id: 'D1', properties: { order_number: 'ORD-1' } }];
};
hubspot.getInvoiceDeal = async () => ({ id: 'D1', properties: { order_number: 'ORD-1' } });
hubspot.clearDealTrigger = async () => ({});

googleStore.dealDocPresence = async () => ({ oc: true, invoice: false });
const persisted = [];
googleStore.persistOrder = async ({ payload }) => {
  persisted.push(payload.order_number);
  return { persisted: true, status: 'Awaiting Customer Approval', driveFileId: null, pdfUrl: null };
};
docRender.renderInvoicePdf = async () => Buffer.from('pdf');

const { refreshModifiedDeals, getLastRefreshSummary } = require('./hermesService');

(async () => {
  await refreshModifiedDeals();
  const firstWindow = searches[0];
  assert.ok(Date.now() - firstWindow > 23 * 60 * 60 * 1000, 'cold start still looks back ~24h');
  assert.strictEqual(persisted.length, 1, 'first click regenerates the existing OC');

  // Second click, immediately after: the window must reach back BEFORE the
  // moment the first run finished, or an edit made seconds ago (and indexed a
  // moment later) is orphaned forever.
  await refreshModifiedDeals();
  const secondWindow = searches[1];
  assert.ok(secondWindow < Date.now() - 9 * 60 * 1000, 'second window overlaps by the grace period, not "since now"');

  // ...and the retry must actually regenerate, not be eaten by the 2-min dedup.
  assert.strictEqual(persisted.length, 2, 'a repeated click regenerates again');

  const summary = getLastRefreshSummary();
  assert.ok(summary && summary.finishedAt && summary.windowStart, 'last-run summary is recorded for /refresh/last');
  assert.deepStrictEqual(summary.regenerated, ['ORD-1:oc']);

  console.log('hermesRefresh.test.js: all assertions passed');
})();
