const { config } = require('./config');

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

async function hubspotFetch(path, options = {}) {
  const response = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.hubspot.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HubSpot API error ${response.status} on ${path}: ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getDeal(dealId) {
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,followup_sent&associations=contacts`);
}

async function getInvoiceDeal(dealId, properties) {
  const params = new URLSearchParams({ properties: properties.join(',') });
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}?${params.toString()}`);
}

async function searchDeals(filterGroups, properties) {
  const body = { filterGroups, properties, limit: 100 };
  const results = [];
  let after;
  do {
    if (after) body.after = after;
    const page = await hubspotFetch('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    results.push(...(page.results || []));
    after = page.paging?.next?.after;
  } while (after);
  return results;
}

async function getContact(contactId) {
  return hubspotFetch(`/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname,followup_sent`);
}

async function getPrimaryContactId(deal) {
  const results = deal?.associations?.contacts?.results;
  if (!results || results.length === 0) return null;
  return results[0].id;
}

async function logNoteOnContact(contactId, body) {
  return hubspotFetch('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_note_body: body,
        hs_timestamp: Date.now(),
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 202,
            },
          ],
        },
      ],
    }),
  });
}

// Reset a boolean trigger checkbox to false once we've acted on it, so the
// hourly poll stops reprocessing the same deal every run (that unbounded
// re-generation is what timed the poll out — 15+ deals × a synchronous pdfkit
// render blocks the event loop). Setting it false re-fires the webhook, but
// classifyTriggerEvent only acts on `true`, so there's no loop.
async function clearDealTrigger(dealId, propertyName) {
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [propertyName]: 'false' } }),
  });
}

// Write the Order Status dropdown back to the deal (auto In Transit / Delivered),
// so HubSpot matches the sheet. `value` must be an option VALUE (e.g. 'Shipped'),
// not its display label ('In Transit') — HubSpot rejects unknown enum values.
// order_status isn't a webhook-watched trigger, so this can't loop.
async function setDealOrderStatus(dealId, value) {
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { order_status: value } }),
  });
}

async function markDealFollowUpSent(dealId) {
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      properties: { followup_sent: 'true' },
    }),
  });
}

async function getListMemberEmails(listId) {
  const emails = [];
  let vidOffset;

  do {
    const params = new URLSearchParams({ count: '100' });
    if (vidOffset) params.set('vidOffset', vidOffset);

    const page = await hubspotFetch(`/contacts/v1/lists/${listId}/contacts/all?${params.toString()}`);
    for (const contact of page.contacts || []) {
      const emailProperty = contact.identity_profiles?.[0]?.identities?.find((i) => i.type === 'EMAIL');
      if (emailProperty?.value) emails.push(emailProperty.value);
    }

    vidOffset = page['has-more'] ? page['vid-offset'] : null;
  } while (vidOffset);

  return emails;
}

module.exports = {
  getDeal,
  getInvoiceDeal,
  clearDealTrigger,
  setDealOrderStatus,
  searchDeals,
  getContact,
  getPrimaryContactId,
  logNoteOnContact,
  markDealFollowUpSent,
  getListMemberEmails,
};
