// One-time: create the three yes/no strike checkboxes on deals so Matt can
// control which fees are comped (struck) per deal, and the total updates.
//   strike_embroidery, strike_art, strike_shipping  (booleancheckbox)
//
//   node --env-file=.env scripts/create-strike-properties.js            (dry run)
//   node --env-file=.env scripts/create-strike-properties.js --confirm
//
// Needs HUBSPOT_PRIVATE_APP_TOKEN (scopes crm.schemas.deals.read+write) in .env.
// Idempotent: a property that already exists (409) is skipped.

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const CONFIRM = process.argv.includes('--confirm');
const BASE = 'https://api.hubapi.com/crm/v3/properties/deals';
const GROUP = 'mo_line_item_extra'; // reuse the group created for the line-item props

const OPTIONS = [
  { label: 'Yes', value: 'true', displayOrder: 0 },
  { label: 'No', value: 'false', displayOrder: 1 },
];
const PROPS = [
  { name: 'strike_embroidery', label: 'Strike Embroidery' },
  { name: 'strike_art', label: 'Strike Art' },
  { name: 'strike_shipping', label: 'Strike Shipping' },
].map((p) => ({ ...p, type: 'bool', fieldType: 'booleancheckbox', groupName: GROUP, options: OPTIONS }));

async function main() {
  if (!TOKEN) { console.error('Missing HUBSPOT_PRIVATE_APP_TOKEN (put it in .env)'); process.exit(1); }
  console.log(`${CONFIRM ? 'CREATING' : 'DRY RUN — would create'} ${PROPS.length} yes/no checkboxes on deals (group ${GROUP}):`);
  for (const p of PROPS) console.log(`  ${p.name.padEnd(18)} "${p.label}"  (bool / booleancheckbox, Yes|No)`);
  if (!CONFIRM) { console.log('\nRe-run with --confirm to create.'); return; }

  let created = 0, skipped = 0, failed = 0;
  for (const p of PROPS) {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    if (res.ok) { created++; console.log(`created ${p.name}`); }
    else if (res.status === 409) { skipped++; console.log(`${p.name} already exists, skipping`); }
    else { failed++; console.log(`FAILED ${p.name} ${res.status}: ${await res.text()}`); }
  }
  console.log(`\nDone: ${created} created, ${skipped} skipped, ${failed} failed.`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
