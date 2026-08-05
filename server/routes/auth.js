const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { requireAuth } = require("../lib/auth");
const { log, ACTIONS } = require("../lib/audit");

const ADMIN_ROLES = ["super_admin", "general_manager"];

// Every auth account, not just the first page.
//
// listUsers() with no arguments takes GoTrue's server-side default of 50 per
// page. Past 50 logins that failed quietly and wrongly: "Create login" stopped
// detecting duplicates, "Reset password" and "Delete login" reported "No login
// exists" for accounts that did, and the User accounts screen showed people
// with a login as having none.
const AUTH_PAGE_SIZE = 200;
async function listAllAuthUsers() {
  const all = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw new Error(error.message);
    const batch = data?.users || [];
    all.push(...batch);
    if (batch.length < AUTH_PAGE_SIZE) return all;
    // Guard against a server that ignores paging and returns the same page.
    if (page > 50) return all;
  }
}

function findAuthUser(users, email) {
  const wanted = (email || "").trim().toLowerCase();
  return users.find((u) => (u.email || "").trim().toLowerCase() === wanted);
}

// GET /api/auth/me — return current user info (requires auth)
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password — let a user change their own password
router.post("/change-password", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "password is required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const { error } = await supabase.auth.admin.updateUserById(req.user.auth_id, {
    password,
    user_metadata: { must_change_password: false },
  });
  if (error) return res.status(500).json({ error: error.message });

  log(req, ACTIONS.PASSWORD_RESET, { self_service: true });
  res.json({ changed: true });
});

// POST /api/auth/create-user — create a Supabase Auth account for a staff member
router.post("/create-user", requireAuth, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Only admins can create user accounts" });
  }

  const { staff_id, password } = req.body;
  if (!staff_id || !password) {
    return res.status(400).json({ error: "staff_id and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("staff_id, name, email, role")
    .eq("staff_id", staff_id)
    .maybeSingle();

  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!staff.email) return res.status(400).json({ error: "Staff member has no email — add one first" });

  let alreadyExists;
  try {
    alreadyExists = findAuthUser(await listAllAuthUsers(), staff.email);
  } catch (e) {
    return res.status(500).json({ error: `Could not check existing logins: ${e.message}` });
  }

  if (alreadyExists) {
    return res.status(409).json({ error: `A login already exists for ${staff.email}` });
  }

  const { data: authUser, error } = await supabase.auth.admin.createUser({
    email: staff.email,
    password,
    email_confirm: true,
    user_metadata: {
      staff_id: staff.staff_id,
      name: staff.name,
      role: staff.role,
      must_change_password: true,
    },
  });

  if (error) return res.status(500).json({ error: error.message });

  log(req, ACTIONS.USER_CREATED, { staff_id, target_email: staff.email, target_role: staff.role });
  res.json({ created: true, email: staff.email, name: staff.name });
});

// POST /api/auth/reset-password — reset a staff member's password (admin only)
router.post("/reset-password", requireAuth, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Only admins can reset passwords" });
  }

  const { staff_id, password } = req.body;
  if (!staff_id || !password) {
    return res.status(400).json({ error: "staff_id and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("email")
    .eq("staff_id", staff_id)
    .maybeSingle();

  if (!staff?.email) return res.status(404).json({ error: "Staff member not found or has no email" });

  let authUser;
  try {
    authUser = findAuthUser(await listAllAuthUsers(), staff.email);
  } catch (e) {
    return res.status(500).json({ error: `Could not look up the login: ${e.message}` });
  }

  if (!authUser) return res.status(404).json({ error: "No login exists for this staff member" });

  const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
    password,
    user_metadata: { must_change_password: true },
  });
  if (error) return res.status(500).json({ error: error.message });

  log(req, ACTIONS.PASSWORD_RESET, { staff_id: req.body.staff_id, target_email: staff.email, self_service: false });
  res.json({ reset: true, email: staff.email });
});

// DELETE /api/auth/user/:staff_id — remove a staff member's login (admin only)
router.delete("/user/:staff_id", requireAuth, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Only admins can remove user accounts" });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("email")
    .eq("staff_id", req.params.staff_id)
    .maybeSingle();

  if (!staff?.email) return res.status(404).json({ error: "Staff member not found" });

  let authUser;
  try {
    authUser = findAuthUser(await listAllAuthUsers(), staff.email);
  } catch (e) {
    return res.status(500).json({ error: `Could not look up the login: ${e.message}` });
  }

  if (!authUser) return res.status(404).json({ error: "No login exists for this staff member" });

  const { error } = await supabase.auth.admin.deleteUser(authUser.id);
  if (error) return res.status(500).json({ error: error.message });

  log(req, ACTIONS.USER_DELETED, { staff_id: req.params.staff_id });
  res.json({ deleted: true });
});

// GET /api/auth/users — list which staff have logins (admin only)
router.get("/users", requireAuth, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Only admins can view user accounts" });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("staff_id, name, email, role, active")
    .eq("active", true)
    .order("name");

  let authEmails;
  try {
    authEmails = new Set((await listAllAuthUsers()).map((u) => (u.email || "").trim().toLowerCase()));
  } catch (e) {
    return res.status(500).json({ error: `Could not list logins: ${e.message}` });
  }

  const result = (staff || []).map((s) => ({
    ...s,
    has_login: authEmails.has((s.email || "").trim().toLowerCase()),
  }));

  res.json({ users: result });
});

module.exports = router;
