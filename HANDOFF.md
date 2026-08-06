# Mayor Agent — Full Handoff

Operational handoff covering **all three repos**. This same file lives in each repo so any one of them is self-contained for a new owner. In `mayor-email-backend` it pairs with `PROJECT_STATUS.md` (detailed done/to-do list).

---

## ⚠️ CURRENT STATE (2026-07-24) — read this first; it supersedes stale details below

- **Live MO sheet ID is `1FTVqNw9voQ6Bkk1US_nv_PVx50Uc1TWIGyxGUJNknnU`** (set via `MO_SHEET_ID` on Render). The old `152hyxQz…` id below is the **DEAD pre-reorg sheet** — never use it. Both services now hard-fail on startup if `MO_SHEET_ID` is unset rather than falling back to it.
- **System is live and doing real work** — HubSpot, Google (Drive/Sheets/Gmail DWD), Claude, Resend all configured on Render. The "everything returns `skipped` by design / this is config-only, don't touch code" framing below is **obsolete**.
- **Leucrocotta is push-driven**, not a 15-min cron: Gmail Pub/Sub → `POST /leucrocotta/gmail-webhook/:secret` → `runInboxPoll`. A `leucrocotta-watch-renew` cron re-registers the Gmail `watch()` every 6 days (it expires in ≤7). `/leucrocotta/poll` is a manual fallback.
- **Order-doc sheet layout is 58 columns**, and the layout is now a **single source of truth in `mo-sheet.js`** (duplicated verbatim in both server repos, like `doc-render.js`) — the two writers + the portal reader all derive column positions from it. The "46-column layout, duplicated, leave as-is" note below is obsolete.
- **Status ladder**: Awaiting Customer Approval → Awaiting Payment → Pending (paid) → In Transit → Delivered, and status writes are now **monotonic** (never regress).
- **Hermes poll is bounded**: `generateDocument` clears the `zc_trigger_oc`/`zd_trigger_invoice` checkbox after a successful generate, so the hourly poll only processes freshly-toggled deals (previously it re-generated every flagged deal every run and timed the cron out).
- **Retired**: the social-drafting poll (now a Claude Project). Delete the orphaned `social-poll` Render cron if still provisioned.
- Full change detail lives in the `project_mayor_agent.md` agent-memory file.

---

## The system

Order-lifecycle automation for Mayor Clothing. **HubSpot** is the system of record; a **Google Sheet** ("MO sheet" — live id in the Current State box above; the `152hyxQz…` id here is the dead pre-reorg one) + **Google Drive** hold order state and generated docs; **Resend/Gmail** send mail; **Claude** drafts replies; **Nickel** handles payments.

| Repo | Role | Hosted |
|------|------|--------|
| `mayor-email-backend` | The agent. Express service, the automation brain. | **Live on Render** |
| `mayor-invoice` | Invoice-PDF generator + customer-facing order portal (JWT auth). | Render (free plan) |
| `mayor-tools` | Single-file browser invoice builder. No backend. | Static / open the file |

All three are on the **mayorclothing** GitHub org. The MO sheet is the shared spine — the backend writes order status to it; the invoice portal reads orders from it.

---

## Repo access & deploy (applies to all repos)

- Push access is **org-gated**. Auth as the org account: `gh auth login` (device flow), then `gh auth setup-git`. `gh` is installed at `C:\Program Files\GitHub CLI\gh.exe`. Pushing as `marcusgafford` alone → **403**.
- Both server repos deploy from a `render.yaml` blueprint; push to `main` and Render auto-deploys.

---

## 1. mayor-email-backend  (the agent — live)

Express (CommonJS). Two sub-agents:

- **Hermes** — a HubSpot deal-property change (or the hourly poll) generates an Order Confirmation / Invoice PDF, persists it to Drive + the MO sheet, and advances order status (Pending → In Transit → Delivered).
- **Leucrocotta** — every 15 min reads unread Gmail, classifies each message, and either flips an order to **Pending** when Nickel reports payment, or drafts a reply in Mayor's voice for Matt to review (accruing per-contact memory in Drive).

**State**: deployed & live at `https://mayor-email-backend.onrender.com` — web + `hermes-poll` (hourly) + `leucrocotta-poll` (every 15 min) crons. `/health` → 200. Both polls currently return `200 skipped` because external services aren't configured — **by design** (green = healthy, red = real failure). All code tested: `npm test` (4 suites), 26 files syntax-clean, endpoints exercised end-to-end, PDF rendering verified.

**Run locally**
```
npm install
cp .env.example .env
npm run dev      # node --watch index.js
npm test         # node --test
```
Boots with no env; polls just report `skipped`. Smoke test:
```
INTERNAL_API_KEY=testkey PORT=4123 node index.js &
curl -s localhost:4123/health
curl -s -X POST localhost:4123/hermes/poll      -H "Authorization: Bearer testkey"
curl -s -X POST localhost:4123/leucrocotta/poll -H "Authorization: Bearer testkey"
```

**`INTERNAL_API_KEY`** is a made-up shared secret; set it **identically** on all three Render services (web + both crons). `sync:false` means Render does NOT auto-fill the crons — enter each by hand. Blank on the web service ⇒ auth rejects everything (401).

**Key files**: `index.js` (wiring), `hermesService.js` (generation / status / webhook classification / poll), `hermesMapping.js` (deal→payload), `doc-render.js` (pdfkit), `googleStore.js` (Drive + MO-sheet), `leucrocotta/*` (inbox agent), `render.yaml`, `.env.example`.

---

## 2. mayor-invoice  (PDF generator + customer portal)

Express **5**. Renders invoice PDFs and serves a customer-facing order portal.

- **Routes**: `POST /generate` (invoice PDF), `GET /orders` → `portal.html`, `/portal/*` (JWT auth: `login`, `logout`, `forgot-password`, `set-password`, `create-account`, `orders`), `GET /health`.
- **Auth**: JWT (`jsonwebtoken`) + `bcryptjs`; user rows live in the MO sheet's `Users` tab.
- **Reads/writes** the same MO sheet (`SHEET_ID` hardcoded in `index.js` and `portal.js`).
- **PDF**: uses `pdfkit`, plus `puppeteer-core` + `@sparticuz/chromium` for headless-Chrome rendering (heavier than the backend's pdfkit-only path).
- **Deploy**: `render.yaml`, service `mayor-invoice`, plan **free**. Intended domain `orders.mayorclothing.com` (`BASE_URL` default).

**Env vars**
| Var | Notes |
|-----|-------|
| `GOOGLE_SERVICE_ACCOUNT` | ⚠️ named `GOOGLE_SERVICE_ACCOUNT` here — the backend calls the same thing `GOOGLE_SERVICE_ACCOUNT_JSON`. Don't copy-paste the key under the wrong name. |
| `JWT_SECRET` | **Must set in prod.** Defaults to a placeholder; code warns if unset when `NODE_ENV=production`. |
| `RESEND_API_KEY` | portal password-reset / notification mail |
| `BASE_URL` | defaults to `https://orders.mayorclothing.com` |
| `PORT` | Render sets it |

**Run locally**: `npm install && node index.js` (→ `:3000`). **No test suite** (`npm test` is a placeholder that errors).

---

## 3. mayor-tools  (browser invoice builder)

A single `index.html` ("Mayor Tools") — a **client-side** invoice generator, no server and no build step. Open it in a browser or drop it on any static host. Nothing to deploy or configure.

---

## What's left — configuration only (backend), in priority order

Everything below is dashboard/console work, not code. Full detail in the backend's `PROJECT_STATUS.md`.

1. **Google service account** — set `GOOGLE_SERVICE_ACCOUNT_JSON` (backend) / `GOOGLE_SERVICE_ACCOUNT` (invoice), grant Gmail **domain-wide delegation** (`gmail.modify`) for `mayor@mayorclothing.com`, set `DRIVE_BRAIN_FOLDER_ID`. Unlocks all persistence + the entire Leucrocotta inbox agent. (`MO_SHEET_ID` already defaulted.)
2. **HubSpot** — create the 4 Deal trigger properties (`zc_trigger_oc`, `zd_trigger_invoice`, `zg_tracking_number`, `zf_delivered_date`), create a private app, set `HUBSPOT_TOKEN` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_ORDER_DEAL_STAGE`, register a `deal.propertyChange` webhook → `/webhooks/hubspot`. Until the properties exist, triggers + poll silently no-op.
3. **Claude** — set `ANTHROPIC_API_KEY` so Leucrocotta drafts replies (without it, it classifies but won't draft).
4. **Resend** — `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_REPLY_TO`, `BRAND_LOGO_URL`.
5. **Invoice portal** — set `JWT_SECRET` and `GOOGLE_SERVICE_ACCOUNT` on the `mayor-invoice` service.

As each is added the corresponding poll stops saying `skipped` and starts acting.

---

## Gotchas (save yourself the debugging)

- **Nickel emails** come from `support@nickel.com` (NOT `notify@`) and are **HTML-only**; `gmailClient` strips tags and collapses whitespace to one line — never anchor regexes on newlines. Order ref lives in the phrase `Payment of $X for <ref> from <payer>` (subject + body) and a labeled `Order Reference` field. Some subjects have an **empty** ref (`for  from …`) — those can't be tied to an order and correctly no-op. `NICKEL_SENDER` defaults to `support@nickel.com`.
- **Two names for the Google key**: `GOOGLE_SERVICE_ACCOUNT_JSON` (backend) vs `GOOGLE_SERVICE_ACCOUNT` (invoice). Same JSON, different var name.
- **Cron `fromService` host wiring failed** (curl exit 7 — couldn't connect). The backend cron `startCommand`s now hardcode the public URL. If you re-introduce `fromService`, verify `$POLL_HOST` resolves to a bare hostname with no scheme.
- **curl exit codes** in cron logs: `7` = can't connect (bad/empty host), `22` = HTTP 4xx/5xx (`-f`) — usually `401` (key mismatch) or `500` (missing config on `/hermes/generate`).
- **Hermes idempotency** is in-memory and resets on restart; the persistent backstop is the MO-sheet row (the poll gates on it). Fine unless restarts cause churn.
- **Duplicated code**: `doc-render.js` exists in both `mayor-email-backend` and `mayor-invoice`; the MO-sheet detail-row layout is duplicated inside `googleStore.js`. Left as-is (marked `ponytail:`) — consolidate only if they diverge.
- **Stale local node servers**: several background `node.exe` processes can linger and answer on ports, giving misleading test results. Kill them before local smoke tests.
