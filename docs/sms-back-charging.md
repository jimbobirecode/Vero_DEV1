# Back charging clubs for SMS

Vero pays the carrier for every text it sends. This is how that cost is measured, priced, and billed back to the club that caused it.

## The thing to understand first

**Carriers bill per segment, not per message.** A segment is 160 characters — but only if every character in the message is in the GSM-7 alphabet. One character that isn't re-encodes the *whole* message as UCS-2, where a segment holds 70 characters instead of 160.

The characters that do this are the ones nobody suspects, because they look like punctuation you already use:

| Character | Looks like | Actually is |
|---|---|---|
| `—` | a dash | U+2014 em dash — not in GSM-7 |
| `’` | an apostrophe | U+2019 curly quote — not in GSM-7 |
| `“ ”` | quote marks | U+201C/D — not in GSM-7 |
| `…` | three dots | U+2026 ellipsis — not in GSM-7 |
| any emoji | — | not in GSM-7, and costs 2 units, not 1 |

This is not theoretical. The golf survey in this repo contained one em dash, which made every golf survey cost **three segments instead of one** — a 200% overcharge on that template, invisible until the carrier bill arrived. It's fixed, and `sms-billing.test.js` now asserts the segment cost of every outgoing template so a reword can't reintroduce it silently.

Word processors and phones substitute these characters automatically. If anyone edits message copy by pasting from Word, Google Docs, or Slack, assume it happened.

## How the pieces fit

```
send time                          invoice time
─────────                          ────────────
lib/sms-billing.js  ──meters──▶  message_log      ──rolls up──▶  statement
  segments, encoding               segments                        totals
  unit price in force              encoding                        by kind
                                   unit_price_cents                by encoding
                                   billable_cents                  warnings
                                       │
                                       └── close ──▶ sms_billing_periods (frozen)
```

Two rules make the numbers defensible:

1. **Price is snapshotted at send time.** Each row stores the unit price it was sent at, not a reference to a rate table. Change the rate in September and August's invoice still adds up to what August's invoice said.
2. **Closing a period freezes it.** After close, the statement is served from stored figures. A late-arriving message or an edited rate shows up as *drift* next to the invoiced number — it never silently replaces it.

Only messages with `status = 'sent'` are charged. Failures are logged in the same table and are counted, reported, and billed at zero.

## Setup

Run the migration once, in the Supabase SQL editor:

```
migrations/sms-back-charge.sql
```

Then set the rate. **There is no default rate on purpose** — it ships as `0`, because a plausible-looking invented price produces invoices that look right and aren't, which is far harder to catch than an obviously missing number. Metering runs from day one regardless; only pricing waits.

| Setting | What it is |
|---|---|
| `sms_rate_cents_per_segment` | The carrier's price per segment, in cents. `$0.0079` → `0.79` |
| `sms_markup_pct` | Vero's margin on top. Kept separate so the pass-through cost is never lost |
| `sms_included_segments_per_period` | Segments included in the subscription before back charging starts |
| `sms_billing_currency` | `USD`, `GBP`, `EUR`, … |

Set them via `PUT /api/settings/:key`, or in Settings on the dashboard.

Finally, recover the cost of messages already sent:

```bash
# Dry run first — this is the default
curl -X POST /api/billing/sms/reprice -d '{"period":"2026-07"}'
curl -X POST /api/billing/sms/reprice -d '{"period":"2026-07","dry_run":false}'
```

Segment counts recovered this way are **exact** — recomputed from the stored message body. Prices are **not**: they use today's rate card, which may not be what was in force when those messages went out. The response says so; don't strip that caveat when passing figures to a club.

## The screen

**Dashboard → Setup → SMS Billing.** General Manager and Super Admin only, matching the server's own gate — the API refuses anything below `general_manager` regardless, but the nav hides it too so a director never clicks into a screen that 403s.

Top to bottom:

- **Notices** — anything needing a decision, above the figures rather than beneath them. No rate configured, UCS-2 spend that could be removed, drift on a closed period.
- **Four KPIs** — segments sent, chargeable after allowance, amount, and whether the period is open or frozen. Failed sends appear here as *"11 failed, not billed"* rather than being silently dropped.
- **Statement** — month picker, `Close & invoice`, and two breakdowns: what the spend went on (nightly surveys, staff shift surveys, event surveys…) and how it was encoded, with UCS-2 marked *avoidable*.
- **Cost preview** — paste any wording, set a recipient count, get segments and projected cost. `Check the live templates` meters every wording that actually goes out. Deliberately placed above the rate card: the cheapest fix for an SMS bill is wording that fits in one segment, not a renegotiated rate.
- **Rate card** — carrier rate, markup, included allowance, currency, and `Reprice older messages`, which previews before it applies.
- **Closed periods** — what was invoiced, by whom, against which reference, with `Void` behind a required reason.

The Survey Builder's per-template segment count was also wrong and is fixed. It used `Math.ceil(length / 160)`, which ignores encoding entirely — so the golf survey, which was genuinely costing three segments, displayed as one. It now uses the same meter as everything else and shows the encoding and any non-GSM characters alongside.

## The endpoints

All require `general_manager` or above — this is money, not reporting.

### `GET /api/billing/sms?period=2026-07`

The statement. Also accepts `?from=` and `?to=`; defaults to the current month.

```json
{
  "status": "open",
  "currency": "USD",
  "rate": { "rate_cents_per_segment": 0.79, "markup_pct": 0, "unit_price_cents": 0.79, "configured": true },
  "totals": {
    "messages_sent": 1204, "messages_failed": 11,
    "segments_sent": 1411, "segments_included": 0, "segments_charged": 1411,
    "amount_cents": 1114.69, "amount": "$11.15"
  },
  "by_kind":     [{ "kind": "survey", "messages": 1180, "segments": 1180, "amount_cents": 932.2 }],
  "by_encoding": [{ "encoding": "gsm7", "messages": 1180, "segments": 1180 }],
  "warnings": []
}
```

`by_kind` is what turns "4,812 segments" into something a club can question. Sends are labelled `survey`, `survey_manual`, `survey_on_visit`, `event_survey`, `staff_survey`, `integration_test`. Anything logged before labelling shipped rolls up as `unattributed`.

### `POST /api/billing/sms/close`

```json
{ "period": "2026-07", "invoice_ref": "INV-1042" }
```

Freezes the month. Refuses a month that hasn't finished (`400`) and a month already closed (`409`). Records who closed it.

### `POST /api/billing/sms/periods/:id/void`

The only way back. Requires a stated reason, and is audited — reissuing an invoice a club has already received should take deliberate effort.

### `POST /api/billing/sms/reprice`

Fills in missing meter readings. Dry run unless `dry_run: false`. Refuses to touch a closed period, and refuses to run at all with no rate configured (which would otherwise write zeros over every row it touched).

### `POST /api/billing/sms/preview`

```json
{ "body": "Aronimink: how was your round — see you soon: https://…", "recipients": 900 }
```

```json
{
  "encoding": "ucs2", "segments": 3, "headroom": 42,
  "non_gsm_characters": [{ "character": "—", "code_point": "U+2014" }],
  "cost_per_recipient": "$0.02", "projected_cost": "$21.33",
  "warnings": ["This message contains \"—\" (U+2014), which GSM-7 cannot carry…"]
}
```

**This is the half of the feature that saves money rather than recovering it.** Run any wording through it before a batch goes out. It also warns when a message is within 10 characters of tipping into a second segment — the food & beverage survey currently sits at 155 of 160, so a longer club name or a longer link would double its cost with no other change.

## Known costs today

Measured against a 19-character club name and a `vero.onrender.com` link:

| Template | Chars | Encoding | Segments | Note |
|---|---|---|---|---|
| Food & beverage survey | 155 | GSM-7 | 1 | 5 characters of headroom — tight |
| Golf survey | 159 | GSM-7 | 1 | was 3 before the em dash was removed |
| Events survey | 149 | GSM-7 | 1 | 11 characters of headroom |
| Staff shift survey | 173 | GSM-7 | **2** | over the 160 limit |

The staff survey is left at two segments deliberately. It's over by 13 characters, which no phrasing tweak recovers, so shortening it is a wording decision for the club rather than a billing one. It's recorded here and asserted in the tests so the cost is known rather than discovered.

## Multi-club

The pilot is single-club: `message_log.club_id` is filled from the `CLUB_ID` env var and the statement filters on it. Rows predating the column are null and still appear on the club's own statement.

For a genuinely shared deployment, two things still need doing: scope `loadSettings()` to a per-club rate card rather than the single `club_settings` table, and drop the `club_id.is.null` fallback from `fetchMessages()` once no unattributed rows remain.

## Tests

```bash
node server/lib/sms-billing.test.js    # 72 — metering, pricing, statement arithmetic
node server/routes/billing.test.js     # 44 — endpoints, closing, pagination, preview, templates
```

The Billing screen itself was checked in a real browser (Chromium via Playwright) against stubbed API responses: the nav item appears, the screen renders every panel, the preview prices a wording and names the offending character, and the role gate matches the server's — F&B Director, Department Head and both Shift Manager roles cannot reach it. That harness lives outside the repo since Playwright isn't a project dependency; re-run it by driving `vero-dashboard.html` with `/api/**` intercepted.

The metering tests are worth reading before changing anything in `lib/sms-billing.js`. They cover the cases that quietly cost money: extension characters that take two septets, escape pairs that can't be split across a segment boundary, emoji that are one code point but two UCS-2 units, and the 153/67 multipart capacities that make a 161-character message cost two segments rather than one and a bit.
