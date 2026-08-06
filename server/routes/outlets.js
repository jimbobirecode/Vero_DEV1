const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

// Validate a nominated owner rather than trusting the id. A stale one would
// silently send every alert for the outlet to nobody.
async function resolveOwner(ownerStaffId) {
  if (!ownerStaffId) return { value: null };
  const { data: staff } = await supabase
    .from("staff")
    .select("staff_id, name, active")
    .eq("staff_id", ownerStaffId)
    .maybeSingle();
  if (!staff) return { error: "That team member no longer exists" };
  if (staff.active === false) return { error: `${staff.name} is not an active team member` };
  return { value: staff.staff_id };
}

// GET /api/outlets?active=true
router.get("/", async (req, res) => {
  let query = supabase
    .from("outlets")
    .select("*")
    .order("name", { ascending: true });

  if (req.query.active === "true") {
    query = query.eq("active", true);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ outlets: data });
});

// POST /api/outlets
router.post("/", async (req, res) => {
  const { name, min_spend_threshold, frequency_limit_days, owner_staff_id } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Outlet name is required" });
  }

  const spend = min_spend_threshold === undefined || min_spend_threshold === "" ? 0 : parseFloat(min_spend_threshold);
  const days = frequency_limit_days === undefined || frequency_limit_days === "" ? 30 : parseInt(frequency_limit_days, 10);
  if (!Number.isFinite(spend) || spend < 0) {
    return res.status(400).json({ error: "Minimum spend must be a number of 0 or more" });
  }
  if (!Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: "Re-survey days must be a whole number of 1 or more" });
  }

  const owner = await resolveOwner(owner_staff_id);
  if (owner.error) return res.status(400).json({ error: owner.error });

  const row = {
    name: name.trim(),
    min_spend_threshold: spend,
    frequency_limit_days: days,
    active: true,
  };
  // Who case alerts for this location go to. Null is fine — the alert falls
  // back to notifying managers.
  if (owner.value) row.owner_staff_id = owner.value;

  let { data, error } = await supabase.from("outlets").insert(row).select().single();
  if (error && /owner_staff_id/.test(error.message || "")) {
    delete row.owner_staff_id;
    ({ data, error } = await supabase.from("outlets").insert(row).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/outlets/:id
router.put("/:id", async (req, res) => {
  const { name, min_spend_threshold, frequency_limit_days, active, template_id, owner_staff_id } = req.body;
  const update = {};

  // Reject bad input rather than coercing it. A number input reports an empty
  // string whenever its contents aren't a valid number, so `parseInt(x) || 30`
  // quietly overwrote real values with the fallback.
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "Outlet name cannot be empty" });
    update.name = String(name).trim();
  }
  if (min_spend_threshold !== undefined) {
    const spend = parseFloat(min_spend_threshold);
    if (!Number.isFinite(spend) || spend < 0) {
      return res.status(400).json({ error: "Minimum spend must be a number of 0 or more" });
    }
    update.min_spend_threshold = spend;
  }
  if (frequency_limit_days !== undefined) {
    const days = parseInt(frequency_limit_days, 10);
    if (!Number.isInteger(days) || days < 1) {
      return res.status(400).json({ error: "Re-survey days must be a whole number of 1 or more" });
    }
    update.frequency_limit_days = days;
  }
  if (active !== undefined) update.active = Boolean(active);

  // Who case alerts raised against this outlet are assigned to. Empty means
  // nobody, and the alert falls back to notifying managers.
  if (owner_staff_id !== undefined) {
    const owner = await resolveOwner(owner_staff_id);
    if (owner.error) return res.status(400).json({ error: owner.error });
    update.owner_staff_id = owner.value;
  }

  // An outlet can nominate its own survey template. Empty string or null means
  // "use the default for the visit type" — validate rather than trust the id,
  // so a stale one cannot silently stop an outlet's surveys.
  if (template_id !== undefined) {
    if (!template_id) {
      update.template_id = null;
    } else {
      const { data: tpl } = await supabase
        .from("survey_templates")
        .select("template_id, active")
        .eq("template_id", template_id)
        .maybeSingle();
      if (!tpl) return res.status(400).json({ error: "That survey template no longer exists" });
      if (!tpl.active) return res.status(400).json({ error: "That survey template is inactive — reactivate it first" });
      update.template_id = template_id;
    }
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  // .select().single() forces an error if zero rows matched — otherwise a
  // blocked or unmatched update would silently report success
  const { data, error } = await supabase
    .from("outlets")
    .update(update)
    .eq("outlet_id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: true, outlet: data });
});

// DELETE /api/outlets/:id — soft-delete (set active = false)
router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("outlets").update({ active: false }).eq("outlet_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
