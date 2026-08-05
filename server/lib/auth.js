const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const STAFF_COLUMNS = "staff_id, name, email, role, active";

// Match the staff row for a signed-in email, case-insensitively.
//
// Supabase Auth normalises the address to lowercase; the staff table holds
// whatever was typed when the person was added. A plain equality match meant
// a row entered as "Jamie@Club.com" created a login fine, reported has_login
// true on the User accounts screen, authenticated against Supabase — and then
// got 403 on every single API call. Every other email comparison in the
// codebase already lowercases both sides (see routes/auth.js); this one is
// the gate, so it is the one that mattered.
//
// Done as an exact match first, falling back to an in-memory compare over the
// active staff, rather than with ilike: an address may legitimately contain
// "_", which ilike would treat as a wildcard and match the wrong person.
async function findStaffByEmail(email) {
  if (!email) return null;

  const { data: exact } = await adminClient
    .from("staff")
    .select(STAFF_COLUMNS)
    .eq("email", email)
    .eq("active", true)
    .maybeSingle();
  if (exact) return exact;

  const { data: all } = await adminClient
    .from("staff")
    .select(STAFF_COLUMNS)
    .eq("active", true);

  const wanted = email.trim().toLowerCase();
  return (all || []).find((s) => (s.email || "").trim().toLowerCase() === wanted) || null;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const token = header.replace("Bearer ", "");
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  const staff = await findStaffByEmail(data.user.email);

  if (!staff) {
    return res.status(403).json({ error: "No active staff account for this email" });
  }

  const mustChange = data.user.user_metadata?.must_change_password === true;
  req.user = { ...staff, auth_id: data.user.id, must_change_password: mustChange };
  next();
}

module.exports = { requireAuth, findStaffByEmail };
