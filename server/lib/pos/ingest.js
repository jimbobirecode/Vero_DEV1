// Turning parsed POS rows into visits.
//
// This was duplicated between the CSV upload and the PDF upload, and the two
// copies had drifted: only one of them knew about spouse suffixes and
// name-based matching, so the same member resolved differently depending on
// which file type the club happened to upload. One implementation now.

const { normalizeOutlet } = require("./shared");

// Builds the outlet lookup. Exact match on the club's own spelling first, then
// a normalised match so "GRILL ROOM", "Grill Room" and "The Grill-Room" all
// find the same outlet. Never fuzzy beyond that — mapping a check to the wrong
// outlet applies the wrong spend threshold, which silently changes who gets
// surveyed.
async function loadOutlets(supabase) {
  const { data } = await supabase
    .from("outlets")
    .select("outlet_id, name, min_spend_threshold, frequency_limit_days")
    .eq("active", true);

  const exact = new Map();
  const normalized = new Map();
  const ambiguous = new Set();

  for (const o of data || []) {
    exact.set(o.name.toLowerCase().trim(), o);
    const key = normalizeOutlet(o.name);
    if (normalized.has(key)) ambiguous.add(key);   // two outlets normalise alike
    else normalized.set(key, o);
  }

  return {
    find(name) {
      const raw = String(name || "").toLowerCase().trim();
      if (!raw) return null;
      if (exact.has(raw)) return exact.get(raw);
      const key = normalizeOutlet(name);
      if (ambiguous.has(key)) return null;         // make the club disambiguate
      return normalized.get(key) || null;
    },
  };
}

// Resolves the POS's idea of a member to a row in the members table.
//
// The POS is the club's other system and its member numbers drift: spouses get
// a suffix, the number may be zero-padded on one side only, and some reports
// carry only a name. Each fallback is tried in confidence order and stops at
// the first hit.
async function resolveMember(supabase, { memberId, memberName }) {
  const id = String(memberId || "").trim();

  if (id) {
    const { data: exact } = await supabase
      .from("members").select("member_id").eq("member_id", id).maybeSingle();
    if (exact) return exact;

    // Spouse / dependant suffix: M473-S, 1234-00, 1234.1 -> the base account.
    if (/[-.][A-Za-z0-9]{1,3}$/.test(id)) {
      const base = id.replace(/[-.][A-Za-z0-9]{1,3}$/, "");
      const { data: baseMatch } = await supabase
        .from("members").select("member_id").eq("member_id", base).maybeSingle();
      if (baseMatch) return baseMatch;
    }

    // Jonas zero-pads account numbers in some reports but not others.
    if (/^0\d+$/.test(id)) {
      const trimmed = id.replace(/^0+/, "");
      const { data: unpadded } = await supabase
        .from("members").select("member_id").eq("member_id", trimmed).maybeSingle();
      if (unpadded) return unpadded;
    }

    // The "member number" column actually held a name.
    if (/[a-zA-Z]{2,}/.test(id) && /[\s,]/.test(id)) {
      const byName = await lookupByName(supabase, id);
      if (byName) return byName;
    }
  }

  // Lightspeed in particular often identifies the customer by name only.
  if (memberName) {
    const byName = await lookupByName(supabase, memberName);
    if (byName) return byName;
  }

  return null;
}

// PostgREST filter values are comma- and paren-delimited, so a name carrying
// either would break out of the or() expression. Anything but letters, spaces
// and hyphens is dropped before it reaches the query.
function safeName(part) {
  return String(part || "").replace(/[^a-zA-ZÀ-ɏ' -]/g, "").trim();
}

async function lookupByName(supabase, raw) {
  const parts = String(raw).split(/[\s,]+/).map(safeName).filter((p) => p.length > 1);
  if (parts.length < 2) return null;

  const [a, b] = parts;
  const { data } = await supabase
    .from("members")
    .select("member_id")
    .or(`and(first_name.ilike.${a},last_name.ilike.${b}),and(first_name.ilike.${b},last_name.ilike.${a})`)
    .limit(2);

  // Two members with the same name is not a match we can act on — surveying
  // the wrong one is worse than not surveying.
  if (!data || data.length !== 1) return null;
  return data[0];
}

// Writes visits for a batch of parsed rows.
//
// Returns the same result shape both upload routes already return, so the
// dashboard needs no change: { created, qualified, skipped, errors, details }.
async function ingestRows(rows, supabase) {
  const outlets = await loadOutlets(supabase);
  const results = { created: 0, qualified: 0, skipped: [], errors: [], details: [], unknown_members: 0 };

  for (const row of rows) {
    const outlet = outlets.find(row.outlet_name);
    if (!outlet) {
      results.skipped.push({
        member_id: row.member_id || row.member_name,
        reason: `Unknown outlet: ${row.outlet_name || "(blank)"}`,
      });
      continue;
    }

    const spend = typeof row.spend_amount === "number"
      ? row.spend_amount
      : parseFloat(String(row.spend_amount).replace(/[$,]/g, ""));
    if (!Number.isFinite(spend)) {
      results.skipped.push({ member_id: row.member_id || row.member_name, reason: "Invalid spend amount" });
      continue;
    }

    const visitDate = normalizeDate(row.visit_date);
    const member = (row.member_id || row.member_name)
      ? await resolveMember(supabase, { memberId: row.member_id, memberName: row.member_name })
      : null;

    const visitorType = member ? "member" : "other";
    const guestName = member ? null : (row.member_name || row.member_id || row.guest_name || "Unknown");

    // A visit only qualifies if there is somebody to send to. An upload
    // carries no phone or email, so a member number the club does not
    // recognise can never be surveyed — recording it as qualifying just puts
    // a permanently unsendable row in the queue.
    const qualifies = visitorType === "member" && spend >= parseFloat(outlet.min_spend_threshold);

    const { error: insertErr } = await supabase.from("visits").insert({
      member_id: member ? member.member_id : null,
      outlet_id: outlet.outlet_id,
      visit_date: visitDate,
      spend_amount: spend,
      server_name: row.server_name || null,
      visitor_type: visitorType,
      guest_name: visitorType !== "member" ? guestName : null,
      qualifies,
    });

    if (insertErr) {
      results.errors.push({ member_id: row.member_id || row.member_name, error: insertErr.message });
      continue;
    }

    results.created++;
    if (qualifies) results.qualified++;
    if (visitorType !== "member") results.unknown_members++;

    results.details.push({
      member_id: member ? member.member_id : guestName,
      outlet: outlet.name,
      spend: spend.toFixed(2),
      qualifies,
      reason: qualifies
        ? "Survey queued"
        : visitorType !== "member"
          ? `Not queued — ${row.member_id ? `member ${row.member_id}` : "this name"} is not in your member list`
          : `Below $${outlet.min_spend_threshold} threshold`
            + (row.checks > 1 ? ` (${row.checks} checks combined)` : ""),
    });
  }

  return results;
}

function normalizeDate(value) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  return new Date().toISOString().split("T")[0];
}

module.exports = { ingestRows, loadOutlets, resolveMember, normalizeDate };
