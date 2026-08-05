// Security middleware: response headers, role authorisation, and rate limiting.

const SUPABASE_ORIGIN = (() => {
  try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ""; }
})();

// Content-Security-Policy is the main defence against stored XSS reaching the
// manager's browser via imported member names or member-written comments.
// 'unsafe-inline' is still required because the dashboard is a single file
// with inline styles and handlers — removing it is the next hardening step.
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src 'self' ${SUPABASE_ORIGIN} https://api.anthropic.com`.trim(),
    "img-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Render terminates TLS in front of the app, so advertise HSTS only when the
  // original request actually arrived over HTTPS.
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.removeHeader("X-Powered-By");
  next();
}

// Role gate. requireAuth must run first — it attaches req.user from the staff
// table. The dashboard hides screens per role, but that is presentation only;
// without this the API happily serves member PII to any signed-in account.
const ROLE_HIERARCHY = {
  super_admin: 100,
  general_manager: 90,
  fb_director: 60,
  dept_head: 40,
  shift_manager: 10,
  golf_shift_manager: 10,
};

function requireRole(...allowed) {
  const permitted = new Set(allowed);
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ error: "Not authenticated" });
    if (!permitted.has(role)) {
      return res.status(403).json({ error: "Your role does not have access to this data" });
    }
    next();
  };
}

// Everyone at or above the given role.
function minimumRole(role) {
  const floor = ROLE_HIERARCHY[role] ?? 0;
  return (req, res, next) => {
    // Signed in but carrying a role this table does not know — a typo in the
    // staff record, or a role added to the database and not to the code.
    // That is an authorisation problem, not an authentication one, and
    // reporting it as 401 sent the dashboard back to the login screen in a
    // loop over credentials that were perfectly valid.
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const level = ROLE_HIERARCHY[req.user.role] ?? -1;
    if (level < 0) {
      return res.status(403).json({ error: `Unrecognised role "${req.user.role}" — ask an administrator to correct it` });
    }
    if (level < floor) {
      return res.status(403).json({ error: "Your role does not have access to this data" });
    }
    next();
  };
}

// Reads stay open to anyone signed in who needs them (a shift manager must
// see the outlet list to upload against it); writes require seniority.
function writeRequires(role) {
  const gate = minimumRole(role);
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    return gate(req, res, next);
  };
}

// Fixed-window limiter. In-memory, so the ceiling is per instance — adequate
// for a single Render service, and it should move to a shared store if this
// ever scales horizontally.
function rateLimit({ windowMs = 60_000, max = 60, key } = {}) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs).unref?.();

  return (req, res, next) => {
    const id = key ? key(req) : (req.ip || "unknown");
    const now = Date.now();
    let entry = hits.get(id);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(id, entry);
    }
    entry.count++;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: "Too many requests — please slow down." });
    }
    next();
  };
}

module.exports = { securityHeaders, requireRole, minimumRole, writeRequires, rateLimit, ROLE_HIERARCHY, contentSecurityPolicy };
