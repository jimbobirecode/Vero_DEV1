const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { notifyStaffMember, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");
const { log, ACTIONS } = require("../lib/audit");

// The owner columns arrived after the table did — see
// migrations/training-owner.sql. A deployment that has not run it yet must
// keep working rather than 500 on every read, so the columns are asked for
// once and dropped from the query if the database says it has never heard of
// them. Cached, because the answer cannot change without a restart.
let ownerColumns = null;   // true / false / null = not yet asked

const WITH_OWNER = "*, outlets(name), staff:owner_staff_id(staff_id, name, email, role)";
const WITHOUT_OWNER = "*, outlets(name)";

function missingOwnerColumn(error) {
  const m = String(error?.message || "");
  return m.includes("owner_staff_id") || m.includes("owner_name");
}

// GET /api/training?limit=10&offset=0&owner=<staff_id|unassigned>
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = parseInt(req.query.offset) || 0;
  const { owner } = req.query;

  const run = async (columns) => {
    let q = supabase
      .from("training_plans")
      .select(columns, { count: "exact" })
      .order("generated_at", { ascending: false });

    // "Whose is this?" and "what has nobody picked up?" are the two questions
    // the screen is for, so both are filters rather than something the client
    // does to a page of ten.
    if (owner === "unassigned") q = q.is("owner_staff_id", null);
    else if (owner) q = q.eq("owner_staff_id", owner);

    return q.range(offset, offset + limit - 1);
  };

  // A filter on a column that does not exist cannot be honoured, and answering
  // it with the unfiltered list would be a lie — "nothing is unassigned" and
  // "I cannot tell you" look identical on screen and only one of them is true.
  const cannotFilter = () => res.status(503).json({
    error: "Training plans cannot be assigned yet — run migrations/training-owner.sql in the Supabase SQL editor.",
  });
  if (owner && ownerColumns === false) return cannotFilter();

  let { data, count, error } = await run(ownerColumns === false ? WITHOUT_OWNER : WITH_OWNER);

  if (error && missingOwnerColumn(error)) {
    ownerColumns = false;
    if (owner) return cannotFilter();
    ({ data, count, error } = await run(WITHOUT_OWNER));
  } else if (!error && ownerColumns === null) {
    ownerColumns = true;
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data, total: count, assignable: ownerColumns !== false });
});

// PUT /api/training/:id/owner — put somebody's name against a plan
//
// Body: { staff_id } to assign, { staff_id: null } to hand it back.
//
// A plan nobody owns is the failure this exists to fix: it is generated on a
// Friday, everyone who reads it assumes somebody else is doing it, and it sits
// at 0/4 for a month. So assigning also emails the person — being made
// responsible for something is not news that should wait until they next open
// the dashboard.
router.put("/:id/owner", async (req, res) => {
  const { staff_id } = req.body;
  if (staff_id === undefined) {
    return res.status(400).json({ error: "staff_id is required (null to unassign)" });
  }

  let staff = null;
  if (staff_id !== null) {
    const { data } = await supabase
      .from("staff")
      .select("staff_id, name, active")
      .eq("staff_id", staff_id)
      .maybeSingle();
    if (!data) return res.status(404).json({ error: "Staff member not found" });
    // Assigning work to somebody who has left is how a plan goes quiet: it
    // looks owned on the screen and nobody is reading the email.
    if (data.active === false) {
      return res.status(400).json({ error: `${data.name} is no longer active.` });
    }
    staff = data;
  }

  const update = staff
    ? { owner_staff_id: staff.staff_id, owner_name: staff.name, assigned_at: new Date().toISOString() }
    : { owner_staff_id: null, owner_name: null, assigned_at: null };

  const { data: updated, error } = await supabase
    .from("training_plans")
    .update(update)
    .eq("plan_id", req.params.id)
    .select("plan_id, week_start, steps, basis_summary, outlets(name)")
    .maybeSingle();

  if (error) {
    if (missingOwnerColumn(error)) {
      ownerColumns = false;
      return res.status(503).json({
        error: "Training plans cannot be assigned yet — run migrations/training-owner.sql in the Supabase SQL editor.",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!updated) return res.status(404).json({ error: "Training plan not found" });

  log(req, ACTIONS.TRAINING_ASSIGNED, {
    plan_id: req.params.id,
    owner_staff_id: staff?.staff_id ?? null,
    owner_name: staff?.name ?? null,
  });

  if (staff) {
    const outlet = updated.outlets?.name || "the club";
    const steps = Array.isArray(updated.steps) ? updated.steps : [];
    const open = steps.filter((s) => !(s && s.done));
    const url = dashboardUrl();

    let body = `Hi ${staff.name},\n\nA training plan for ${outlet} has been assigned to you.\n`;
    if (updated.basis_summary) body += `\nWhy: ${updated.basis_summary}\n`;
    if (open.length) {
      body += `\nOutstanding (${open.length} of ${steps.length}):\n`;
      // The steps themselves, not a link to them. A manager reads this on a
      // phone between covers, and an email that only says "you have a plan"
      // makes them go and look for what is in it.
      for (const s of open) body += `  · ${typeof s === "string" ? s : s.text}\n`;
    }
    if (url) body += `\nTick them off as they are done: ${url}\n`;
    body += `\n${CLUB_NAME}`;

    notifyStaffMember(staff.staff_id, `[Club Vero] Training plan assigned to you — ${outlet}`, body)
      .catch((e) => console.error("Training assignment notification failed:", e.message));
  }

  res.json({ updated: true, owner_name: staff?.name ?? null });
});

// PUT /api/training/:id/steps — update step completion status
// Body: { steps: [...updated steps array] }
router.put("/:id/steps", async (req, res) => {
  const { steps } = req.body;
  if (!Array.isArray(steps)) return res.status(400).json({ error: "steps array is required" });

  const { error } = await supabase
    .from("training_plans")
    .update({ steps })
    .eq("plan_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: true });
});

// DELETE /api/training/:id — remove a training plan
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("training_plans")
    .delete()
    .eq("plan_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
