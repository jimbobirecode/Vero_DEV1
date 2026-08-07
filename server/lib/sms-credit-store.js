// The database side of SMS credit.
//
// Every balance change goes through the two Postgres functions in
// migrations/sms-credit.sql — never through an UPDATE written here. That is not
// stylistic: reading a balance in Node and writing it back is a lost update the
// moment two sends overlap, which for a nightly batch is always. The functions
// do the check and the decrement in one statement against one locked row.
//
// The decisions (may we send, should we warn, should we top up) live in
// sms-credit.js and are pure. This file only moves data.

const { supabase } = require("./supabase");
const credit = require("./sms-credit");

const CLUB_ID = process.env.CLUB_ID || null;

// A missing table is not an error worth crashing a send over — it means the
// migration has not been run. Callers treat a null account as "no credit
// system", which with enforcement off is exactly right.
function missingSchema(error) {
  return error && /does not exist|schema cache|Could not find/i.test(error.message || "");
}

let warnedMissing = false;
function warnMissingOnce() {
  if (warnedMissing) return;
  warnedMissing = true;
  console.error(
    "[sms-credit] the credit tables are not present — run migrations/sms-credit.sql. " +
    "Sending continues unmetered against credit until they exist."
  );
}

async function getAccount(clubId = CLUB_ID) {
  try {
    let q = supabase.from("sms_credit_accounts").select("*").limit(1);
    q = clubId ? q.eq("club_id", clubId) : q.is("club_id", null);
    const { data, error } = await q;
    if (error) {
      if (missingSchema(error)) { warnMissingOnce(); return null; }
      console.error("[sms-credit] could not read the account:", error.message);
      return null;
    }
    return data?.[0] || null;
  } catch (e) {
    console.error("[sms-credit] could not read the account:", String(e));
    return null;
  }
}

// Creates the account if it does not exist. Used by the settings screen and by
// the first top-up, never by the send path — a send must not quietly bring a
// credit account into being.
//
// Returns { account, reason, detail }. It used to return null for every kind of
// failure, and the route turned any null into "the credit tables are not set
// up" — so a NOT NULL violation on club_id reported as a missing migration and
// sent people to re-run SQL that had worked. A setup error has to say which
// setup error it is, or it is worse than no message at all.
async function ensureAccount(clubId = CLUB_ID) {
  const existing = await getAccount(clubId);
  if (existing) return { account: existing, reason: "ok" };

  const { error } = await supabase
    .from("sms_credit_accounts")
    .insert({ club_id: clubId, balance_cents: 0 });

  if (error && !/duplicate key/i.test(error.message || "")) {
    if (missingSchema(error)) {
      warnMissingOnce();
      return { account: null, reason: "no_tables", detail: error.message };
    }
    console.error("[sms-credit] could not create the account:", error.message);
    return { account: null, reason: "insert_failed", detail: error.message };
  }

  const account = await getAccount(clubId);
  if (!account) {
    // The insert reported success but the row cannot be read back. In practice
    // this is PostgREST serving a stale schema cache after a fresh migration.
    return { account: null, reason: "not_readable", detail: "The account was created but could not be read back." };
  }
  return { account, reason: "ok" };
}

// Why is there no account?
//
// Read-only, and it creates nothing — GET /api/credit must not bring an account
// into being as a side effect of someone opening a screen. It distinguishes the
// three states that all previously showed the same "tables are not set up"
// message, only one of which was ever that.
async function diagnose(clubId = CLUB_ID) {
  // Does the table answer at all?
  const { error: tableErr } = await supabase
    .from("sms_credit_accounts")
    .select("account_id", { head: true, count: "exact" });

  if (tableErr) {
    return missingSchema(tableErr)
      ? { reason: "no_tables", detail: tableErr.message }
      : { reason: "unreadable", detail: tableErr.message };
  }

  // The table is fine, so are the functions? A migration that half-applied
  // leaves tables without the two functions that move money, and the failure
  // would otherwise not surface until the first send tried to debit.
  const { error: rpcErr } = await supabase.rpc("debit_sms_credit", {
    p_club_id: clubId,
    p_amount_cents: 0,          // zero: proves the function exists, changes nothing
    p_message_log_id: null,
    p_kind: null,
    p_idempotency_key: "probe:" + (clubId || "default"),
  });
  if (rpcErr && /does not exist|Could not find/i.test(rpcErr.message || "")) {
    return { reason: "no_functions", detail: rpcErr.message };
  }

  return { reason: "no_account_yet" };
}

// Debit for one message. Atomic — see the function's comment in the migration.
//
// `idempotencyKey` must be stable for a given send attempt so a retry cannot
// charge twice. The message_log row id is the natural choice: one row, one
// message, one debit.
async function debit({ clubId = CLUB_ID, amountCents, messageLogId, kind, idempotencyKey }) {
  if (!(amountCents > 0)) return { ok: true, reason: "no_charge", balance_after: null };

  try {
    const { data, error } = await supabase.rpc("debit_sms_credit", {
      p_club_id: clubId,
      p_amount_cents: amountCents,
      p_message_log_id: messageLogId || null,
      p_kind: kind || null,
      p_idempotency_key: idempotencyKey,
    });
    if (error) {
      if (missingSchema(error)) { warnMissingOnce(); return { ok: true, reason: "no_credit_system" }; }
      console.error("[sms-credit] debit failed:", error.message);
      // A billing outage must not become a sending outage. The message goes and
      // the shortfall is recoverable from message_log, which still records the
      // segments and the price — losing a member's survey is not.
      return { ok: true, reason: "debit_error", error: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row?.ok, reason: row?.reason || "unknown", balance_after: row?.balance_after ?? null };
  } catch (e) {
    console.error("[sms-credit] debit failed:", String(e));
    return { ok: true, reason: "debit_error", error: String(e) };
  }
}

// Put money back. Used for top-ups, refunds, manual adjustments, and for
// reversing the debit on a message that was charged and then failed to send.
async function creditAccount({
  clubId = CLUB_ID, amountCents, entryType = "topup", idempotencyKey,
  description = null, paymentIntentId = null, sessionId = null,
  messageLogId = null, actorEmail = null,
}) {
  try {
    const { data, error } = await supabase.rpc("credit_sms_account", {
      p_club_id: clubId,
      p_amount_cents: amountCents,
      p_entry_type: entryType,
      p_idempotency_key: idempotencyKey,
      p_description: description,
      p_payment_intent: paymentIntentId,
      p_session_id: sessionId,
      p_message_log_id: messageLogId,
      p_actor_email: actorEmail,
    });
    if (error) {
      if (missingSchema(error)) { warnMissingOnce(); return { ok: false, reason: "no_credit_system" }; }
      console.error("[sms-credit] credit failed:", error.message);
      return { ok: false, reason: "error", error: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row?.ok, reason: row?.reason || "unknown", balance_after: row?.balance_after ?? null };
  } catch (e) {
    console.error("[sms-credit] credit failed:", String(e));
    return { ok: false, reason: "error", error: String(e) };
  }
}

// Undo a debit for a message that was charged and then did not go out.
//
// Recorded as its own ledger entry rather than by deleting the debit: a club
// querying its balance is owed the sequence of events, not a tidied version of
// it. The idempotency key is derived from the debit's, so a retried reversal
// cannot refund twice.
async function reverseDebit({ clubId = CLUB_ID, amountCents, messageLogId, idempotencyKey }) {
  if (!(amountCents > 0)) return { ok: true, reason: "no_charge" };
  return creditAccount({
    clubId,
    amountCents,
    entryType: "reversal",
    idempotencyKey: "reverse:" + idempotencyKey,
    description: "Message could not be sent",
    messageLogId,
  });
}

async function ledger({ clubId = CLUB_ID, limit = 100, offset = 0, type = null } = {}) {
  let q = supabase
    .from("sms_credit_ledger")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  q = clubId ? q.eq("club_id", clubId) : q.is("club_id", null);
  if (type) q = q.eq("entry_type", type);

  const { data, count, error } = await q;
  if (error) {
    if (missingSchema(error)) { warnMissingOnce(); return { entries: [], total: 0 }; }
    throw new Error(error.message);
  }
  return { entries: data || [], total: count || 0 };
}

// Everything that is not the balance itself: thresholds, auto top-up settings,
// Stripe references, the in-flight lock. Kept apart from the balance so there
// is exactly one code path that can move money.
async function updateAccount(fields, clubId = CLUB_ID) {
  const forbidden = ["balance_cents", "club_id"];
  for (const key of forbidden) {
    if (key in fields) {
      throw new Error(`${key} cannot be set directly — balance changes go through the ledger`);
    }
  }

  let q = supabase.from("sms_credit_accounts").update({ ...fields, updated_at: new Date().toISOString() });
  q = clubId ? q.eq("club_id", clubId) : q.is("club_id", null);
  const { error } = await q;
  if (error) {
    if (missingSchema(error)) { warnMissingOnce(); return null; }
    throw new Error(error.message);
  }
  return getAccount(clubId);
}

// Take the auto top-up lock. Returns false if someone else already holds it.
//
// The compare-and-set is the point: `topup_in_flight_at is null` in the WHERE
// means two concurrent sends cannot both start a charge. A stale lock is
// cleared by the caller first, using the expiry rule in sms-credit.js.
async function claimTopupLock(clubId = CLUB_ID) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - credit.TOPUP_LOCK_MS).toISOString();

  let q = supabase
    .from("sms_credit_accounts")
    .update({ topup_in_flight_at: now })
    .or(`topup_in_flight_at.is.null,topup_in_flight_at.lt.${stale}`)
    .select("club_id");
  q = clubId ? q.eq("club_id", clubId) : q.is("club_id", null);

  const { data, error } = await q;
  if (error) {
    console.error("[sms-credit] could not claim the top-up lock:", error.message);
    return false;
  }
  return (data || []).length > 0;
}

async function releaseTopupLock(clubId = CLUB_ID, errorMessage = null) {
  try {
    await updateAccount({ topup_in_flight_at: null, last_topup_error: errorMessage }, clubId);
  } catch (e) {
    console.error("[sms-credit] could not release the top-up lock:", String(e));
  }
}

async function markWarned(clubId = CLUB_ID) {
  try {
    await updateAccount({ low_balance_notified_at: new Date().toISOString() }, clubId);
  } catch (e) {
    console.error("[sms-credit] could not record the low-balance warning:", String(e));
  }
}

module.exports = {
  getAccount, ensureAccount, diagnose, debit, creditAccount, reverseDebit,
  ledger, updateAccount, claimTopupLock, releaseTopupLock, markWarned,
  CLUB_ID,
};
