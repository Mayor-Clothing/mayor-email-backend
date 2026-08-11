// One-time: create the Batch F per-line-item deal properties + their group in
// HubSpot, via the Properties API. The connected HubSpot MCP can only edit
// records, not schema, so this uses a Private App token instead.
//
// Setup: create a HubSpot Private App with scopes crm.schemas.deals.read +
// crm.schemas.deals.write, put its token in mayor-email-backend/.env as
// HUBSPOT_PRIVATE_APP_TOKEN, then:
//   node --env-file=.env scripts/create-hubspot-properties.js            (dry run)
//   node --env-file=.env scripts/create-hubspot-properties.js --confirm  (actually create)
//
// Idempotent: a property/group that already exists (409) is skipped, not fatal.
// Field #8 is intentionally NOT here — its content is still undecided.

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const CONFIRM = process.argv.includes('--confirm');
const BASE = 'https://api.hubapi.com/crm/v3/properties/deals';

const GROUP = { name: 'mo_line_item_extra', label: 'Order Line Item Details', displayOrder: -1 };

// name -> {label, type, fieldType}. Names mirror internal-names.md.
const SLOTS = [1, 2, 3, 4, 5];
const PROPS = [
  ...SLOTS.map((i) => ({ name: `product_page_${i}`, label: `Product Page #${i}`, type: 'string', fieldType: 'text' })),
  ...SLOTS.map((i) => ({ name: `mockup_${i}`,       label: `Mockup #${i}`,       type: 'string', fieldType: 'text' })),
  ...SLOTS.map((i) => ({ name: `orig_price_${i}`,   label: `Orig Price #${i}`,   type: 'number', fieldType: 'number' })),
];

async function hs(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function main() {
  if (!TOKEN) { console.error('Missing HUBSPOT_PRIVATE_APP_TOKEN (put it in .env)'); process.exit(1); }

  console.log(`${CONFIRM ? 'CREATING' : 'DRY RUN — would create'} 1 group + ${PROPS.length} properties on deals\n`);
  console.log(`  group: ${GROUP.name} ("${GROUP.label}")`);
  for (const p of PROPS) console.log(`  prop:  ${p.name.padEnd(16)} ${p.type}/${p.fieldType}  "${p.label}"`);
  if (!CONFIRM) { console.log('\nRe-run with --confirm to create.'); return; }

  // Group first — properties reference it by groupName.
  const g = await hs('/groups', GROUP);
  console.log(g.ok ? `\n[group] created ${GROUP.name}` :
    g.status === 409 ? `\n[group] ${GROUP.name} already exists, skipping` :
    `\n[group] FAILED ${g.status}: ${g.body}`);

  let created = 0, skipped = 0, failed = 0;
  for (const p of PROPS) {
    const r = await hs('', { ...p, groupName: GROUP.name });
    if (r.ok) { created++; console.log(`[prop]  created ${p.name}`); }
    else if (r.status === 409) { skipped++; console.log(`[prop]  ${p.name} already exists, skipping`); }
    else { failed++; console.log(`[prop]  FAILED ${p.name} ${r.status}: ${r.body}`); }
  }
  console.log(`\nDone: ${created} created, ${skipped} skipped, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
