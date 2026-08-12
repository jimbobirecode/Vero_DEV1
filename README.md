# Vero — MVP build

Built against the developer brief: a single-club pilot, fully automated, low-cost stack.

## Deploying on Render, with Supabase as the database

Supabase Edge Functions only run on Supabase's own infrastructure, so they were converted into a standard Express app in `server/` that Render can host. Supabase now serves purely as the database (Postgres) — including Vault, which is just a Postgres extension and works identically over the network from Render.

**One-time Supabase setup:**
1. Run `schema.sql` in the Supabase SQL editor.
2. Run `vault_setup.sql` (enables the Vault helper the Settings screen's Save button uses).
3. Note your project's `SUPABASE_URL` and `service_role` key (Project Settings → API) — not the `anon` key.

**Deploying to Render:**
1. Push this project to a GitHub repo.
2. In Render: New → Blueprint → point it at the repo. `render.yaml` defines everything — one web service plus three cron jobs (nightly survey send, hourly reminders, weekly AI analysis).
3. Render will prompt for the env vars marked `sync: false` in `render.yaml`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLUB_ID`, `SURVEY_BASE_URL`, `ANTHROPIC_API_KEY`. `CRON_SECRET` is auto-generated and shared with the cron jobs automatically.
4. After the first deploy, copy the web service's Render URL into `SURVEY_BASE_URL` (both on the web service and — since `render.yaml` already links them — the cron jobs pick it up too).
5. Sendly/SendGrid can be set either as env vars (pre-launch) or via the Settings screen once deployed (Vault-backed, takes priority).

**Local development:** copy `.env.example` to `.env`, `npm install`, `npm start`. Runs on `http://localhost:3000` by default.

Tested: the server boots cleanly, serves both the dashboard and survey pages, and the cron endpoints correctly reject requests without the right `x-cron-secret` header (401) before ever touching Supabase.

## What's here

| File | What it is |
|---|---|
| `vero-dashboard.html` | **The GM dashboard.** Ten-plus screens, role-based access, and now real (not just simulated) calls to the backend for Members and Integrations — falls back to in-page demo state if no backend is reachable. |
| `survey-page.html` | The 5-question member survey. Now reads its token from the URL and actually POSTs to `/api/survey-response/:token`. (Fixed a real bug here: an escaped-apostrophe typo was silently breaking this file's JavaScript entirely — caught by actually parsing the script rather than assuming it worked.) |
| `server/` | **The Express app deployed to Render.** `index.js` is the entry point; `routes/` has one file per concern (integrations, members, surveys, analyze, survey-response, notifications); `lib/` has the shared Supabase client, Vault helpers, and Sendly/SendGrid senders. |
| `render.yaml` | Render Blueprint — one web service + three cron jobs (send-surveys nightly, send-reminders hourly, analyze-weekly on Fridays). |
| `package.json` / `.env.example` | Node dependencies and the env vars the server expects. |
| `schema.sql` | Postgres schema for Supabase: members, outlets (real Aronimink thresholds), visits, survey_responses, training_plans, case_alerts, club_integrations. |
| `vault_setup.sql` | One-time SQL to enable the Vault helper function credentials are stored through. |
| `migrations/sms-credit.sql` | **Prepaid SMS credit.** The balance, the ledger, and the atomic debit that stops sending at zero. See `docs/sms-credit.md`. |
| `parse_pos_report.py` | Real, tested parser for Aronimink's actual POS export format. |
| `edge-functions/` | The original Supabase Edge Function versions — kept as reference only. Not used in the Render deployment; logic is identical to `server/`, just Deno-flavored. |

## What's simulated vs. real

The dashboard and survey page run entirely client-side with realistic mock data — you can open and use them right now with no setup. The edge functions are real, working code against the actual Sendly/SendGrid/Anthropic APIs, but they need three things from you to go live, exactly as the brief specifies:

1. **Membership export** — member_id, name, phone (E.164), email, comm preference, opt-out flag.
2. **Which outlets are in scope and their spend thresholds** — one conversation with the F&B Director.
3. **A sample end-of-shift report** so the parser can be configured to that POS format.

Once those three are in hand, this is a Supabase project (free tier to start) + Vercel deploy for the dashboard + API keys for Sendly/SendGrid/Anthropic — matching the brief's "low cost, fast to build" stack, not a rebuild.

## Real data test (Aronimink Golf Club, 06/28/2026)

You uploaded an actual end-of-shift report — this is the piece that was previously just a placeholder. Results:

- **`parse_pos_report.py`** — a real, working parser for this club's POS format (Northstar Technologies "Daily Sales By Location"). Handles the format's actual quirks discovered from the file itself: outlet grouping via "Location Name:" / "Total for:" markers, server and member names that wrap onto sub-lines when too long (e.g. "Jessica McGarrey" splitting across three text lines), and one genuine PDF text-layer quirk where a name and member number ran together with no space at all in the source ("CastilloE60").
- **Verified, not assumed**: parsed dollar totals and covers counts were cross-checked against the report's own "Total for:" subtotal lines for all three outlets and matched exactly — $2,709.25 / $756.52 / $438.00, all ✓.
- **`parsed_visits_sample.json`** — the 102 checks it extracted, with eligibility (qualifies + reason) applied per check.
- Result: **80 of 102 checks qualify** for a survey under starting thresholds.

**This corrected something significant in the dashboard.** The outlets I'd invented for the first two passes — "Main Dining Room," "The Grille Room," "Halfway House" — don't exist. Aronimink's actual outlets are **Golf Patio, Belmont Dining Room, and Belmont Poolside** (only three, not four). I renamed these throughout `vero-dashboard.html` — Overview, Outlets, Trends, Staff Mentions, AI Insights, Training Actions, Case Alerts, Survey Builder — and replaced the fabricated Upload preview with real rows from this file. Thresholds in Survey Builder ($75 / $15 / $20) are starting guesses based on typical check size in the export, not confirmed numbers — that's still a conversation with the F&B Director, per the brief.

## Corrections from the first pass

Re-checked against the brief's own spec tables and fixed a few things the first draft got wrong:
- **Survey question order** was NPS, overall, food, service, comment — not what I'd built. Fixed in both `survey-page.html` and `schema.sql`.
- **Eligibility isn't just spend threshold** — there's a frequency cap too (don't re-survey the same member within a configurable window). Added `frequency_limit_days` to the schema and the check to `send_surveys.ts`.
- **Staff Mentions is a comment-derived recognition table**, not a star-rating table — the survey never asks a guest to rate a specific server; names come from AI-scanning the free-text comments.
- **The AI output has real structure** the first draft flattened: urgency (critical/watch/maintain), a root-cause headline, theme clusters with sentiment/trend, and steps tagged immediate/this week/ongoing. `analyze_weekly.ts` and the Training Actions screen now reflect that.

## Members & Integrations (new)

Two things were added directly to the dashboard:

**Members screen** — add members one at a time, or bulk-import a CSV matching the six-field CRM export the brief specifies (member_id, first_name, last_name, phone_number, email_address, communication_preference, opt_out_flag). Includes a downloadable template, column validation, and a searchable table. Seeded with real member names/numbers pulled from the actual Aronimink export (phone/email are placeholders — the POS report doesn't carry contact info). Restricted to General Manager access, since it's the one screen with member PII, matching the brief's own access rules.

**Settings → Integrations** — input Sendly (API Key, optional From Number) and SendGrid (API Key, From Email) credentials, with Save and Test buttons per provider.

**On the security model, to be direct about it:** a real Sendly API key or SendGrid API key should never be stored in a browser, in `localStorage`, or embedded in a client-side dashboard's code — anyone with access to that page (or its network traffic) could read it out. What's in `vero-dashboard.html` right now is a **UI demo**: clicking Save masks the field and flips a status badge, but nothing leaves the page. The real architecture is the new backend pieces:

- **`schema.sql`** — added a `club_integrations` table that stores non-secret fields (from-number, from-email) directly, but only a *reference id* for the actual secrets. The secrets themselves live in **Supabase Vault**, encrypted at rest.
- **`edge-functions/save_integrations.ts`** — the real endpoint the Settings form should call. It writes the secret into Vault and returns only a boolean — never the value, not even to confirm it saved correctly.
- **`edge-functions/send_surveys.ts`** — updated to read credentials from Vault via `club_integrations` at send-time, falling back to plain environment variables if a club hasn't used the GUI yet (keeps the original single-club pilot setup working).
- **`edge-functions/import_members.ts`** — server-side counterpart to the Members screen's CSV upload, for membership lists too large to comfortably parse in a browser tab; validates E.164 phone format and required fields per row.

To make this real: point the dashboard's Save/Test buttons at `save_integrations.ts` and `import_members.ts` instead of their current in-page simulation, and run the one-time SQL in the comment at the bottom of `save_integrations.ts` to create the Vault helper function.

## Prepaid SMS credit (new)

The club buys message credit up front through Stripe, every text spends it, and at zero, text sending stops until they top up. Full detail in **`docs/sms-credit.md`** — the short version:

**Dashboard → Setup → SMS Credit.** Balance, what it roughly buys, top up, automatic top-up, payment history, and what credit was spent on by day and message type. General Manager only, matching the server's gate.

What was built:

- **`migrations/sms-credit.sql`** — the account, the ledger, and the two Postgres functions that are the only things allowed to move a balance. Also adds the per-message meter readings to `message_log`.
- **`server/lib/sms-credit.js`** — the rules, pure and exhaustively tested: what a message costs, whether there is enough to send it, when to warn, when to top up automatically.
- **`server/lib/stripe.js`** — Checkout for manual top-ups, off-session charges for automatic ones. Card details never touch this server, which is what keeps the deployment out of PCI scope.
- **`server/routes/credit.js`** and **`server/routes/stripe-webhook.js`** — the API, and the webhook that is the *only* thing which grants credit.

Four properties this had to get right, because each one is a way to lose or invent money:

- **The debit is atomic.** `debit_sms_credit()` decrements with `balance_cents >= amount` inside the `WHERE`, so the check and the deduction are one statement against one locked row. Reading a balance in Node and writing it back would let two concurrent sends spend the same last cent — silently, under exactly the load a nightly batch creates. There's a test that races two sends at a one-message balance and asserts exactly one wins.
- **A payment is only real when Stripe says so.** Credit is granted by the webhook, never by the browser returning to a success URL — a redirect proves nothing, and trusting it would let anyone with the link credit themselves. The webhook verifies Stripe's signature over the raw request body, which is why it's mounted with `express.raw()` ahead of the JSON parser.
- **Stripe retries, so every write is idempotent.** Retries can arrive for days. Each credit goes through a key derived from the payment intent, with a unique index making a double-credit impossible rather than unlikely.
- **A message that doesn't send isn't charged.** The debit happens before the carrier call so the hard stop is real; if the send then fails, the debit is reversed as its own ledger entry rather than deleted. A club querying its balance is owed the sequence of events, not a tidied version.

Two defaults that look like omissions and aren't:

- **No default per-message price.** Ships at `0`, and the screen says so plainly. An invented price drains a balance at a fictional rate, and a plausible wrong number is far harder to notice than an obviously missing one.
- **Enforcement is off until switched on.** `sms_credit_enabled` defaults to `false`, so running the migration meters and records without blocking. A deployment upgrading into this must not suddenly stop sending surveys because nobody has bought credit yet.

Running out is designed to be recoverable rather than surprising: warnings at two thresholds, automatic top-up against a saved card, and a batch that hits zero stops immediately rather than grinding through 800 more identical failures — leaving those members untouched so the next run picks them up.

**Along the way this found a live bug.** Carriers bill per *segment*, and a segment is 160 characters only while every character is in the GSM-7 alphabet. The golf survey template contained a single em dash (`—`), which forced UCS-2 — 70 characters per segment — making every golf survey cost **three segments instead of one**. Nothing in the product would have shown it until the bill arrived. It's now a hyphen, the event survey had the same character, and `sms-billing.test.js` asserts the segment cost of every outgoing template so a reword can't reintroduce it. The Survey Builder's own count was wrong too — `Math.ceil(length / 160)`, which ignores encoding entirely — and now uses the real meter.

Still needed to go live: the per-segment price from Sendly, and a Stripe account with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set. Everything else is in place and tested.

## Watchlist — did the recovery actually work? (new)

Service recovery reports how fast the club rang somebody and whether the case was closed. Both describe what the *club* did. Neither is evidence it worked. This tracks the member from the bad visit to their next one and grades the outcome on what they said. Full detail in **`docs/watchlist.md`**; the short version:

**Dashboard → Intelligence → Watchlist.** Everyone still owed a good visit, longest wait first, and the recovery rate underneath. **And a banner on the Visits screen**: pick a member for a visit and, if they are owed one, it says what they scored, how long ago, whether the case was closed, and their own comment. That banner is the part that changes an outcome — by the time a name reaches a monthly report, they have been and gone.

**Closing the case does not clear the member.** This is the one decision everything else follows from. A manager rings, marks the alert resolved, the recovery rate goes up — and all that has actually happened is that the club believes it went well. The member stays on the list until they come back and answer another survey, or the watch window runs out. "We called and they seemed fine" is exactly the belief this exists to test, so it is the one thing that cannot end the watch.

Four outcomes: **not been back**, **came back but was never surveyed** (nobody knows), **recovered**, **still unhappy**. The last two come off the list — the question is settled either way, and a list that keeps answered questions on it stops being read.

Three rules stop the number lying:

- **The rate is measured only on members who came back.** Counting those who have not yet would make it a measure of how *recent* the incidents are — a club with one bad week would watch its rate collapse before anybody had had a chance to return. With nothing graded, the rate is `null` and the screen says "nobody has been back yet", not "0% recovered".
- **A visit within 36 hours is the same occasion, not a return.** A member who ate in the clubhouse and then the halfway house on one evening has not come back, and grading the club on a visit nobody could have acted on between times scores it for something it did not do.
- **Every incident is graded, not just the newest.** A member who had a bad visit, came back, and had another is *both* a failed recovery and a fresh open case. The first version graded only their latest incident and reported 100% recovered on a member who plainly had not been.

Past the window they drop off: no longer a recovery problem, now a retention one, which is what Member health on the Members screen is for. Keeping them on both would put one person on two lists with two different recommended actions.

No migration — it reads tables that already exist. `dept_head` and above, matching Case Alerts.

## Not yet built

- **Authentication.** Nothing in `server/` checks who's calling it yet — `/api/members`, `/api/integrations/save`, etc. are wide open on whatever URL Render gives the service. The cron endpoints are protected by `CRON_SECRET`, but the dashboard's own API calls aren't gated behind a login. This is the actual next step before this touches real member PII or real SMS spend: wire up Supabase Auth, and check the caller's role (GM/F&B Director/Read-only) server-side, not just in the dashboard's UI logic.
- **A second POS format.** `parse_pos_report.py` is specific to Aronimink's Northstar Technologies export — a club on Jonas, Club Essential, etc. needs its own parser written against its own sample file.
- Wiring the parsed POS output into the `visits` table automatically (right now `parse_pos_report.py` runs standalone and writes JSON; connecting it to the Upload screen's actual file input and inserting into Supabase is the remaining gap there).
- Confirmation on whether `member_number` suffixes like `M473-S` should match 1:1 to a distinct membership record or resolve to a shared household account for frequency-cap purposes.
- CLUB_ID is currently a hardcoded placeholder in the dashboard's JS (`'demo-club-id'`) — once there's a login, this comes from the session instead.

Happy to build any of these next — authentication is probably the highest-leverage one now that real credentials and member data are actually flowing.
