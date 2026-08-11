# Batch F — HubSpot property name contract

Single source of truth for the new per-line-item HubSpot deal properties.
**Marcus: fill in the "ACTUAL HubSpot name" column when you can get into HubSpot.**
Once filled, wiring is mechanical (see "Build steps" per field below).

Status: **CREATED, VERIFIED LIVE & WIRED** (2026-08-11) — all 15 properties + the
`mo_line_item_extra` group created via `scripts/create-hubspot-properties.js`
and confirmed present via the HubSpot MCP. The recommended names below ARE the
actual names (script used them verbatim). Code wiring for all three families is
COMMITTED in both repos (orig_price, product_page, mockup — see git log). Tests
pass. Field #8 resolved (see below) — it was a card-ordering note, not a new field.

Post-wiring notes:
- Widening the portal read range surfaced that `rush_fee` (col BG) was already
  beyond the old `A:BF` range and never reached the portal — incidentally fixed.
- The new columns (BH..BQ) overlap the legacy BG:CZ debris zone (prior session's
  pending cleanup). A fresh write overwrites its own row, so debris self-heals as
  orders regenerate, but stale rows 3-13 may show stray links/images until that
  range is cleared. Recommend clearing BG:CZ.
- Mockup is portal-only (NOT in the PDF) — confirm with Matt if he wants it there.

Decisions locked (2026-08-11):
- `product_page_N` (details link): **PDF goes per-item too** — update
  `doc-render.js:107,225` in BOTH repos alongside the portal change.
- HubSpot dev-platform access: **confirmed yes** (unblocks Batch G regen button).
- Old order-level `product_page` becomes vestigial once per-item lands — pull
  it off Matt's entry card, but leave the property until we confirm nothing
  else reads it.

---

## Property table (fill in the last column)

| Field (#) | Purpose | Recommended name | HubSpot type | ACTUAL HubSpot name |
|---|---|---|---|---|
| Details link #5 | per-item "Additional Details" link (replaces one shared order-level link) | `product_page_1` | single-line text | `<<FILL IN>>` |
| | | `product_page_2` | single-line text | `<<FILL IN>>` |
| | | `product_page_3` | single-line text | `<<FILL IN>>` |
| | | `product_page_4` | single-line text | `<<FILL IN>>` |
| | | `product_page_5` | single-line text | `<<FILL IN>>` |
| Mockup #6 | per-item mockup/proof image URL (NEW column, distinct from existing product image/`url`) | `mockup_1` | single-line text | `<<FILL IN>>` |
| | | `mockup_2` | single-line text | `<<FILL IN>>` |
| | | `mockup_3` | single-line text | `<<FILL IN>>` |
| | | `mockup_4` | single-line text | `<<FILL IN>>` |
| | | `mockup_5` | single-line text | `<<FILL IN>>` |
| Orig price #11 | per-item "was" price for strikethrough (fixes hardcoded `orig_price: null`) | `orig_price_1` | number | `<<FILL IN>>` |
| | | `orig_price_2` | number | `<<FILL IN>>` |
| | | `orig_price_3` | number | `<<FILL IN>>` |
| | | `orig_price_4` | number | `<<FILL IN>>` |
| | | `orig_price_5` | number | `<<FILL IN>>` |
Field #8 RESOLVED (2026-08-11): NOT a new field. Marcus clarified it just meant
"place per-item product_page after the mockup field and before description in
the HubSpot card." No new property, no new code — pure card-layout ordering
(the per-item block below already reflects it).

That's **15 properties total** — needs a NEW property group (you were at 48/50
on the current one).

---

## Recommended HubSpot card layout (data-entry ergonomics for Matt)

Card display order is fully decoupled from the sheet/portal — `hermesMapping.js`
reads every field by NAME, never position — so arrange the card for Matt's
entry flow with zero downstream risk.

**Card 1 — "Order Info"** (fill once per order):
`order_number` → `club` → `customer_email` → `shippingbilling_address` →
`c_billing_address` (only if different) → `ship_date` → `print_background` →
`payment_link` → `payment_terms` → fees (`za_embroidery`, `zb_art_setup`,
`shipping_cost`, `rush_fee`, `z_sample_reimbursement`, `custom_main_label`) →
`unstrike`.

**Card 2 — "Line Items"** — grouped PER ITEM (not per field-type), each block:
```
Item N:  product_N → mockup_N → product_page_N →
         description_N → sizes_N →
         quantity_N → orig_price_N → price_N
```
Rhythm per block: identity (product/mockup/link) → specs (desc/#8/sizes) →
money (qty/was/now, was next to now). Per-item grouping means Matt finishes one
garment before the next, and partial orders (2 of 5 items) fill 2 blocks and
stop instead of scrolling across 5 separate field-type sections.

---

## Build steps once names are filled in

**Orig price #11 (smallest — 2 lines, downstream already works):**
1. `hermesMapping.js`: add `const ORIG_PRICE_PROPS = [<<names>>];` beside
   `QTY_PROPS`/`PRICE_PROPS` (lines 13-14); add the 5 names to
   `INVOICE_PROPERTIES`; change line 67 `orig_price: null` →
   `orig_price: n(p[ORIG_PRICE_PROPS[i]]) || null`.
2. Done — `googleStore.js:122`, `mo-sheet.js` (`orig_price_1..5` cols already
   exist), `doc-render.js:203,226-243`, `portal.html:886-888` already render it.

**Details link #5 (per-item):**
1. `hermesMapping.js`: add `PRODUCT_PAGE_PROPS` array + to `INVOICE_PROPERTIES`;
   read per-item in the loop; push `product_page` onto each `line_items` object.
2. `mo-sheet.js`: append `p1_product_page..p5_product_page` cols AFTER col 58
   (never insert mid-list).
3. `googleStore.js buildDetailRow`: read them (`get(i,'product_page')` pattern).
4. `portal.js`: add `product_page` to per-item parse.
5. `portal.html`: change `d.product_page` → `item.product_page` inside the
   forEach loop (~line 910).
6. `doc-render.js:107,225` (BOTH repos): switch to per-item product_page.

**Mockup #6 (per-item, new image column):**
Same 5-file threading as #5 (`mockup_N` → `p1_mockup..p5_mockup` cols after 58 →
buildDetailRow → portal.js parse), then render a NEW `<img>` column in the
portal line-items table alongside (not replacing) the existing product image.
New header cell + per-item `<img>` render block.

**Field #8:** resolve content first, then same threading pattern, displayed
between description and sizes on portal + doc.
