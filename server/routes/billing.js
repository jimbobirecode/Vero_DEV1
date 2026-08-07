// SMS back charging — statements, period closing, and cost preview.
//
// The arithmetic all lives in lib/sms-billing.js, which is pure and tested.
// This file is the thin part: fetch rows, hand them over, and manage the one
// piece of state a billing system genuinely needs — which periods are closed
// and therefore frozen.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");
const B = require("../lib/sms-billing");

const CLUB_ID = process.env.CLUB_ID || null;

async function loadSettings() {
  const { data, error } = await supabase.from("club_settings").select("key, value");
  if (error) throw new Error(error.message);
  const settings = {};
  for (const row of data || []) settings[row.key] = row.value;
  return settings;
}

// message_log rows for a window.
//
// Paged rather than fetched in one call: PostgREST caps a response at 1,000
// rows by default, and a club sending a nightly batch passes that inside a
// month. An invoice built from a silently truncated result set is the exact
// failure this feature cannot have, so the loop runs until a short page proves
// it reached the end.
const PAGE = 1000;
async function fetchMessages({ from, to, clubId }) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("message_log")
      .select("log_id, channel, status, body, segments, encoding, unit_price_cents, billable_cents, kind, created_at, club_id")
      .eq("channel", "sms")
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (from) q = q.gte("created_at", from);
    if (to) q = q.lt("created_at", to);
    // Only filter by club when both the deployment and the rows agree one
    // exists. Rows written before the column was added have a null club_id and
    // must not vanish from the club's own statement.
    if (clubId) q = q.or(`club_id.eq.${clubId},club_id.is.null`);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// A window from either ?period=YYYY-MM or an explicit ?from/?to pair.
function resolveWindow(query) {
  if (query.period) {
    const bounds = B.monthBounds(query.period);
    if (!bounds) return { error: "period must be a month in YYYY-MM form, e.g. 2026-07" };
    return bounds;
  }
  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && isNaN(from)) return { error: "from is not a valid date" };
    if (to && isNaN(to)) return { error: "to is not a valid date" };
    if (from && to && from >= to) return { error: "from must be before to" };
    return { period: null, from: from ? from.toISOString() : null, to: to ? to.toISOString() : null };
  }
  // Default to the current calendar month, which is what someone opening a
  // billing screen almost always wants.
  const now = new Date();
  return B.monthBounds(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
}

async function findClosedPeriod(period) {
  if (!period) return null;
  try {
    let q = supabase
      .from("sms_billing_periods")
      .select("*")
      .eq("period", period)
      .neq("status", "void")
      .limit(1);
    q = CLUB_ID ? q.or(`club_id.eq.${CLUB_ID},club_id.is.null`) : q;
    const { data } = await q;
    return data?.[0] || null;
  } catch {
    // The table arrives with migrations/sms-back-charge.sql. Without it every
    // period is simply open, which is the correct reading.
    return null;
  }
}

// GET /api/billing/sms?period=2026-07
// GET /api/billing/sms?from=...&to=...
//
// The statement for a window. A closed period returns the figures that were
// frozen at close, plus a live recomputation alongside them so any drift is
// visible rather than silently applied.
router.get("/sms", async (req, res) => {
  const window = resolveWindow(req.query);
  if (window.error) return res.status(400).json({ error: window.error });

  try {
    const [settings, rows] = await Promise.all([
      loadSettings(),
      fetchMessages({ from: window.from, to: window.to, clubId: CLUB_ID }),
    ]);

    const live = B.statement(rows, settings, { from: window.from, to: window.to });
    live.period.period = window.period;

    const closed = await findClosedPeriod(window.period);
    if (!closed) {
      log(req, ACTIONS.SMS_STATEMENT_VIEWED, { period: window.period, status: "open" });
      return res.json({ ...live, status: "open", closed: false });
    }

    // The invoiced numbers are what the club owes. The live figures are shown
    // next to them, never in place of them: a late-arriving message or an
    // edited rate must be something a human decides to act on, not something
    // that quietly changes a number already sent out.
    const drift = B.round6(live.totals.amount_cents - Number(closed.amount_cents));
    log(req, ACTIONS.SMS_STATEMENT_VIEWED, { period: window.period, status: closed.status });

    res.json({
      ...(closed.statement || live),
      status: closed.status,
      closed: true,
      closed_at: closed.closed_at,
      closed_by: closed.closed_by_email,
      invoice_ref: closed.invoice_ref,
      recomputed: {
        segments_sent: live.totals.segments_sent,
        amount_cents: live.totals.amount_cents,
        drift_cents: drift,
        matches: drift === 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/billing/sms/periods — closed periods, newest first.
router.get("/sms/periods", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("sms_billing_periods")
      .select("period_id, period, period_start, period_end, status, messages_sent, segments_sent, segments_charged, amount_cents, currency, closed_at, closed_by_email, invoice_ref")
      .order("period", { ascending: false })
      .limit(Math.min(parseInt(req.query.limit) || 24, 100));

    if (error) {
      if (/does not exist/i.test(error.message)) {
        return res.status(503).json({ error: "Billing periods are not set up yet — run migrations/sms-back-charge.sql." });
      }
      return res.status(500).json({ error: error.message });
    }
    res.json({ periods: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/billing/sms/close  { period: "2026-07", invoice_ref?, notes? }
//
// Freezes a month. After this the statement is served from the stored figures,
// so what the club was told it owes stays what it owes.
router.post("/sms/close", async (req, res) => {
  const bounds = B.monthBounds(req.body?.period);
  if (!bounds) return res.status(400).json({ error: "period must be a month in YYYY-MM form, e.g. 2026-07" });

  // A month cannot be closed before it is over. Closing early produces an
  // invoice that is simply missing the rest of the month's sends, and because
  // closing freezes the total, nothing later would correct it.
  if (new Date(bounds.to) > new Date()) {
    return res.status(400).json({ error: `${bounds.period} has not finished yet — it can be closed from ${bounds.to.slice(0, 10)}.` });
  }

  try {
    const existing = await findClosedPeriod(bounds.period);
    if (existing) {
      return res.status(409).json({
        error: `${bounds.period} was already closed on ${existing.closed_at}. Void it first if it genuinely needs reissuing.`,
        period: existing,
      });
    }

    const [settings, rows] = await Promise.all([
      loadSettings(),
      fetchMessages({ from: bounds.from, to: bounds.to, clubId: CLUB_ID }),
    ]);
    const st = B.statement(rows, settings, { from: bounds.from, to: bounds.to });
    st.period.period = bounds.period;

    const card = B.rateCard(settings);
    const { data, error } = await supabase
      .from("sms_billing_periods")
      .insert({
        club_id: CLUB_ID,
        period: bounds.period,
        period_start: bounds.from,
        period_end: bounds.to,
        status: "closed",
        messages_sent: st.totals.messages_sent,
        messages_failed: st.totals.messages_failed,
        segments_sent: st.totals.segments_sent,
        segments_included: st.totals.segments_included,
        segments_charged: st.totals.segments_charged,
        amount_cents: st.totals.amount_cents,
        currency: st.currency,
        rate_cents_per_segment: card.rate_cents_per_segment,
        markup_pct: card.markup_pct,
        statement: st,
        closed_by_email: req.user?.email || null,
        invoice_ref: req.body?.invoice_ref || null,
        notes: req.body?.notes || null,
      })
      .select()
      .single();

    if (error) {
      if (/does not exist/i.test(error.message)) {
        return res.status(503).json({ error: "Billing periods are not set up yet — run migrations/sms-back-charge.sql." });
      }
      return res.status(500).json({ error: error.message });
    }

    log(req, ACTIONS.SMS_PERIOD_CLOSED, {
      period: bounds.period,
      segments: st.totals.segments_charged,
      amount_cents: st.totals.amount_cents,
      invoice_ref: req.body?.invoice_ref || null,
    });

    res.json({ closed: true, period: data, statement: st });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/billing/sms/periods/:id/void  { reason }
//
// The only way to reopen a month. Deliberately a separate, audited action
// rather than a flag on close: reissuing an invoice a club has already received
// is a decision someone should have to make on purpose.
router.post("/sms/periods/:id/void", async (req, res) => {
  if (!req.body?.reason) return res.status(400).json({ error: "A reason is required to void a closed period" });

  const { data, error } = await supabase
    .from("sms_billing_periods")
    .update({ status: "void", notes: `VOID: ${req.body.reason}` })
    .eq("period_id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "No such billing period" });

  log(req, ACTIONS.SMS_PERIOD_VOIDED, { period: data.period, reason: req.body.reason });
  res.json({ voided: true, period: data });
});

// POST /api/billing/sms/reprice  { period?, from?, to?, dry_run? }
//
// Meters and prices rows that carry no meter reading — messages sent before
// this shipped, or while the rate was still zero.
//
// Segment counts recovered this way are exact, because they are recomputed from
// the stored body. Prices are not: they use today's rate card, which may not be
// the rate that was in force when the message went out. The response says so
// plainly, and rows in a closed period are refused outright rather than
// retroactively changing an invoiced figure.
router.post("/sms/reprice", async (req, res) => {
  const window = resolveWindow(req.body || {});
  if (window.error) return res.status(400).json({ error: window.error });

  const dryRun = req.body?.dry_run !== false;

  try {
    if (window.period) {
      const closed = await findClosedPeriod(window.period);
      if (closed) {
        return res.status(409).json({
          error: `${window.period} is closed and was invoiced at ${closed.amount_cents} cents. Void the period first if it must be repriced.`,
        });
      }
    }

    const settings = await loadSettings();
    const card = B.rateCard(settings);
    if (!card.configured) {
      return res.status(400).json({
        error: `No SMS rate is configured. Set ${B.SETTING_KEYS.RATE} in Settings to your carrier's per-segment price in cents before repricing.`,
      });
    }

    const rows = await fetchMessages({ from: window.from, to: window.to, clubId: CLUB_ID });
    const stale = rows.filter((r) => r.segments == null || r.unit_price_cents == null || Number(r.unit_price_cents) === 0);

    const updates = stale.map((r) => {
      const priced = B.meterAndPrice(r.body, settings);
      return {
        log_id: r.log_id,
        segments: priced.segments,
        encoding: priced.encoding,
        unit_price_cents: priced.unit_price_cents,
        billable_cents: r.status === "sent" ? priced.billable_cents : 0,
      };
    });

    const preview = {
      window: { period: window.period, from: window.from, to: window.to },
      messages_examined: rows.length,
      messages_repriced: updates.length,
      segments_recovered: updates.reduce((a, u) => a + u.segments, 0),
      amount_cents: B.toCents(updates.reduce((a, u) => B.round6(a + Number(u.billable_cents)), 0)),
      rate_applied: card.unit_price_cents,
      caveat: "Segment counts are recomputed exactly from each message body. Prices use the current rate card, which may differ from the rate in force when these messages were sent.",
    };

    if (dryRun) return res.json({ ...preview, dry_run: true, applied: false });

    // Updated one row at a time rather than upserted in bulk: an upsert on a
    // partial column set would null out every column not named, and the columns
    // not named here include the message body and the delivery status.
    let applied = 0;
    const failures = [];
    for (const u of updates) {
      const { log_id, ...fields } = u;
      const { error } = await supabase.from("message_log").update(fields).eq("log_id", log_id);
      if (error) failures.push({ log_id, error: error.message });
      else applied++;
    }

    log(req, ACTIONS.SMS_REPRICED, { period: window.period, repriced: applied, amount_cents: preview.amount_cents });
    res.json({ ...preview, dry_run: false, applied: true, rows_updated: applied, failures });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/billing/sms/preview  { body }
//
// What a given wording will cost, before anyone sends it to the whole
// membership. This is the half of the feature that saves money rather than
// merely recovering it: the em dash that used to sit in the golf survey made
// every one of those messages cost three segments instead of one, and nothing
// in the product would have shown that until the bill arrived.
router.post("/sms/preview", async (req, res) => {
  const body = req.body?.body;
  if (typeof body !== "string" || !body.length) {
    return res.status(400).json({ error: "body is required" });
  }

  try {
    const settings = await loadSettings();
    const metered = B.meter(body);
    const card = B.rateCard(settings);
    const priced = B.priceMessage(metered, card);
    const offenders = B.offendingCharacters(body);

    const recipients = Math.max(0, parseInt(req.body?.recipients) || 0);

    const warnings = [];
    if (offenders.length) {
      warnings.push(
        `This message contains ${offenders.map((o) => `"${o.character}" (${o.code_point})`).join(", ")}, which GSM-7 cannot carry. ` +
        `That re-encodes the whole message as UCS-2, cutting a segment from 160 characters to 70 — it now costs ${metered.segments} segment(s) ` +
        `instead of ${B.meter(body.replace(/[^\x00-\x7F]/g, "-")).segments}. Replacing those characters with plain ASCII equivalents removes the difference.`
      );
    }
    if (metered.segments === 1 && metered.headroom <= 10) {
      warnings.push(
        `Only ${metered.headroom} character(s) of headroom before this costs a second segment. A longer club name or a longer link would tip it over.`
      );
    }
    if (metered.segments > 1) {
      warnings.push(`This message costs ${metered.segments} segments — every recipient is billed ${metered.segments} times.`);
    }

    res.json({
      encoding: metered.encoding,
      characters: [...body].length,
      units: metered.units,
      segments: metered.segments,
      headroom: metered.headroom,
      non_gsm_characters: offenders,
      unit_price_cents: priced.unit_price_cents,
      cost_per_recipient_cents: priced.billable_cents,
      cost_per_recipient: B.formatMoney(B.toCents(priced.billable_cents), card.currency),
      recipients: recipients || null,
      projected_cost: recipients
        ? B.formatMoney(B.toCents(B.round6(priced.billable_cents * recipients)), card.currency)
        : null,
      rate_configured: card.configured,
      warnings,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
