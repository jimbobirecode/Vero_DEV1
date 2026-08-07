# Prepaid SMS credit

The club buys message credit up front through Stripe. Every text spends it. At zero, text sending stops until they top up.

## Setup

1. Run `migrations/sms-credit.sql` in the Supabase SQL editor. This is the only SMS billing migration — it adds the per-message meter columns, the credit account, the ledger, and the two Postgres functions that move money.

2. Set the price. Both are server-side settings, not club-facing — this is Vero's pricing, not something the club adjusts:

   ```bash
   PUT /api/settings/sms_rate_cents_per_segment   { "value": "0.79" }   # $0.0079/segment
   PUT /api/settings/sms_markup_pct               { "value": "0" }      # your margin, kept separate
   ```

   **There is deliberately no default.** It ships at `0`, and the credit screen says so in as many words. An invented price drains a balance at a fictional rate, and a plausible wrong number is far harder to notice than an obviously missing one. At zero, nothing is deducted and the hard stop can never engage.

3. Configure Stripe. Set `STRIPE_SECRET_KEY`, then create a webhook at <https://dashboard.stripe.com/webhooks> pointing at `https://<your-service>/api/stripe/webhook`, subscribed to:

   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`. **Do not set one key without the other** — without the webhook secret every event is rejected and a club can pay without being credited.

4. Take a first top-up, confirm the balance moved, then switch on enforcement:

   ```bash
   PUT /api/settings/sms_credit_enabled   { "value": "true" }
   ```

   Enforcement is off by default so that running the migration meters and records without blocking. A deployment upgrading into this must not suddenly stop sending surveys because nobody has bought credit yet.

## The screen

**Dashboard → Setup → SMS Credit**, General Manager and above, matching the server's gate on `/api/credit`.

- **Balance**, what it roughly buys in messages, and whether automatic top-up is on.
- **Top up** — presets or any amount, with an option to save the card. Opens Stripe's own hosted page.
- **Automatic top-up** — trigger level, top-up amount, and the low-balance warning threshold.
- **Payments** — every top-up, refund and adjustment, with who made it.
- **What credit was used on** — by day and message type. A day's 412 surveys are one line, not 412.

Deliberately absent: no rate card, no cost preview, no encoding or segment detail. That is Vero's side of the arrangement, not the club's.

## Four things this had to get right

Each is a way to lose or invent money.

### The debit is atomic

`debit_sms_credit()` decrements with the balance check inside the `WHERE`:

```sql
update sms_credit_accounts
   set balance_cents = balance_cents - p_amount_cents
 where club_id is not distinct from p_club_id
   and balance_cents >= p_amount_cents
returning balance_cents into v_balance;
```

The check and the deduction are one statement against one locked row. Two sends racing for the last cent cannot both win, because the second one's `WHERE` no longer matches. Reading a balance in Node and writing it back would overdraw under exactly the load a nightly batch creates — and would do it silently. `senders-credit.test.js` races two sends at a one-message balance and asserts exactly one succeeds.

A `check (balance_cents >= 0)` constraint backs this up regardless of how the row is reached, including a hand-written `UPDATE` in the SQL editor.

### A payment is only real when Stripe says so

Credit is granted by the webhook and nowhere else. Returning to a `?topup=success` URL proves nothing — anyone with the link could hit it. The webhook verifies Stripe's signature over the **raw** request body, which is why it is mounted with `express.raw()` ahead of the JSON parser in `index.js`; parsing and re-serialising produces different bytes and every signature would fail.

The amount credited is Stripe's `amount_received`, not our own metadata: a partial capture must credit what was actually taken.

### Every write is idempotent

Stripe retries webhooks for up to three days, on any non-2xx and sometimes after a 200. Each credit goes through `idempotency_key` — derived from the payment intent id, not the event id, since one payment can arrive under several events — and a unique index makes a double-credit impossible rather than unlikely. Unhandled event types return 200, or Stripe would retry them forever.

### A message that doesn't send isn't charged

The debit happens *before* the carrier call, so the hard stop is real. The cost of that ordering is a debit for a message that then fails, so the debit is reversed — as its own `reversal` ledger entry rather than by deleting the original. A club querying its balance is owed the sequence of events, not a tidied version.

## Running out

Designed to be recoverable rather than surprising:

1. **Two warning thresholds.** "Low" means sort this out this week; "critical" means you are about to stop sending. One threshold either fires too early to be taken seriously or too late to act on. Warnings re-arm on any top-up and repeat at most daily, so a nightly batch crossing the line sends one email rather than several hundred.

2. **Automatic top-up.** When the balance falls below the trigger, a saved card is charged off-session. The in-flight lock is the important part: a 900-message batch must fire one charge, not 900. It is a compare-and-set in the database with a ten-minute expiry, so two processes racing produce one charge and a crashed process cannot wedge it permanently.

   Off-session means nobody is at the keyboard, so a card demanding 3-D Secure will fail. That is a real outcome, not an edge case — the managers are emailed and the lock is released so the next crossing can try again.

3. **A batch that hits zero stops.** `InsufficientCreditError` is its own class so the batch senders can tell it from a carrier failure. They break rather than grinding through 800 more recipients producing identical errors. Nothing is marked as sent, so the next run picks up exactly who was missed.

## Endpoints

All require `general_manager` or above, except the webhook.

| Endpoint | What it does |
|---|---|
| `GET /api/credit` | Balance, state, what it buys, auto top-up settings, saved card |
| `GET /api/credit/history` | Payments individually; usage rolled up by day and type |
| `POST /api/credit/checkout` | `{ amount_cents, save_card? }` → a Stripe Checkout URL |
| `POST /api/credit/save-card` | Checkout in setup mode — saves a card without charging |
| `PUT /api/credit/settings` | Thresholds and auto top-up |
| `POST /api/credit/adjust` | `{ amount_cents, reason }` — manual credit or debit, audited |
| `POST /api/stripe/webhook` | Stripe only. Signature-verified. The only thing that grants credit |

`/adjust` is the one path that moves money without Stripe, which is why it demands a reason and is written to the audit log.

## Why segments still exist under the hood

Carriers bill per *segment*, not per message: 160 characters, but only while every character is in the GSM-7 alphabet. One character that isn't — an em dash, a curly apostrophe, an emoji — re-encodes the whole message as UCS-2, where a segment holds 70. A two-segment message must debit twice what a one-segment message does, so `lib/sms-billing.js` still meters every send. The club just never sees that arithmetic.

This found a live bug: the golf survey template contained a single em dash, making every golf survey cost three segments instead of one. It is now a hyphen, the event survey had the same character, and `sms-billing.test.js` asserts the segment cost of every outgoing template so a reword cannot reintroduce it silently.

## Tests

```bash
node server/lib/sms-billing.test.js      # 47 — metering and pricing
node server/lib/sms-credit.test.js       # 61 — costs, gating, thresholds, auto top-up
node server/lib/senders-credit.test.js   # 30 — the send path, races, reversals, warnings
node server/routes/credit.test.js        # 40 — endpoints, webhook signature, idempotency
```

The webhook tests are the ones to read before changing anything in `stripe-webhook.js`: they assert that an unsigned event grants nothing, that a retried event credits once, and that an unhandled type still returns 200.
