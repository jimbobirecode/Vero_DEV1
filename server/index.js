require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const path = require("path");

const { requireAuth } = require("./lib/auth");

const { securityHeaders, minimumRole, writeRequires, rateLimit } = require("./lib/security");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(securityHeaders);

// The dashboard is served by this same service, so same-origin calls need no
// CORS at all. ALLOWED_ORIGINS (comma-separated) opts specific origins in;
// anything else is refused rather than mirrored back.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);               // same-origin / curl
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);                           // no CORS headers -> browser blocks
  },
  credentials: false,
}));

// Stripe's webhook, mounted before express.json() and with the raw body.
//
// The signature Stripe sends is computed over the exact bytes it posted. Parsing
// them into an object and re-serialising produces a different byte sequence, so
// verification fails and every payment is refused — which is why this cannot sit
// with the other routes below. It is public by necessity; the signature is the
// authentication. See routes/stripe-webhook.js.
app.use("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), require("./routes/stripe-webhook"));

app.use(express.json({ limit: "5mb" })); // 5mb headroom for CSV member imports posted as JSON

// Blanket ceiling on the API. Deliberately generous — it is a backstop
// against scripted abuse, not normal dashboard use.
app.use("/api", rateLimit({ windowMs: 60_000, max: 300 }));

// --- Cron endpoints require a shared secret ---
// These run automated sends and cost real Sendly/SendGrid money per call, so
// they're not left open just because they're POST requests. Render Cron Jobs
// (see render.yaml) pass this header automatically.
function requireCronSecret(req, res, next) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET is not configured on the server" });
  }
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Public routes (no auth required) ---
app.get("/api/health", (req, res) => res.json({
  ok: true,
  commit: process.env.RENDER_GIT_COMMIT || null,
  branch: process.env.RENDER_GIT_BRANCH || null,
}));

// Read-only connectivity check for operators. Requires the cron secret: it
// is a diagnostic, not a public endpoint, and it must never modify data or
// return business records.
app.get("/api/health/db", requireCronSecret, async (req, res) => {
  const { supabase: sb } = require("./lib/supabase");
  const out = {
    commit: process.env.RENDER_GIT_COMMIT || null,
    branch: process.env.RENDER_GIT_BRANCH || null,
  };
  try {
    const { count, error } = await sb
      .from("outlets")
      .select("outlet_id", { count: "exact", head: true });
    out.database = error ? { ok: false, error: error.message } : { ok: true, outlet_count: count ?? 0 };
  } catch (e) {
    out.database = { ok: false, error: String(e) };
  }
  res.json(out);
});

const { CLUB_NAME, CLUB_ID_SLUG } = require("./lib/club-config");
app.get("/api/club-config", (req, res) => res.json({
  club_name: CLUB_NAME,
  club_id: CLUB_ID_SLUG,
  supabase_url: process.env.SUPABASE_URL,
  supabase_anon_key: process.env.SUPABASE_ANON_KEY || "",
}));

// Both are reachable without a session, so they get their own tighter
// ceilings: survey-response is guarded only by a token in the URL, and the
// auth routes cover password changes and account creation.
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, max: 30 }), require("./routes/auth"));
app.use("/api/survey-response", rateLimit({ windowMs: 15 * 60_000, max: 40 }), require("./routes/survey-response"));
// Staff workday survey — same deal: guarded only by the token in the link.
app.use("/api/staff-survey-response", rateLimit({ windowMs: 15 * 60_000, max: 40 }), require("./routes/staff-survey-response"));

// Unsubscribe link from survey emails. Public by necessity — the member is
// not signed in — and guarded by the survey token they already hold.
//
// The ceiling is generous because this endpoint is also the target of the
// List-Unsubscribe-Post header: a mail provider honours a one-click
// unsubscribe by POSTing here itself, and every one of those arrives from a
// handful of provider IPs. A tight per-IP limit would start refusing genuine
// opt-outs mid-batch, and a refused unsubscribe becomes a spam complaint.
// Abuse potential is low either way — the worst anyone can do with a token
// they already hold is stop their own mail.
app.use("/u", express.urlencoded({ extended: false }), rateLimit({ windowMs: 15 * 60_000, max: 500 }), require("./routes/unsubscribe"));

// One-tap call logging, reached from the link in an alert escalation email.
// Staff-facing rather than member-facing, so the ceiling is modest — a club
// logs a handful of these a day, and nothing here is a mail-provider target
// the way the unsubscribe endpoint is.
app.use("/c", express.urlencoded({ extended: false }), rateLimit({ windowMs: 15 * 60_000, max: 120 }), require("./routes/recovery-log"));

// --- Cron routes (protected by cron secret, not user auth) ---
app.use("/api/cron", requireCronSecret, require("./routes/surveys"));         // send-surveys
app.use("/api/cron", requireCronSecret, require("./routes/analyze"));         // analyze-weekly
app.use("/api/cron", requireCronSecret, require("./routes/notifications"));   // daily-digest

// Audit retention: delete entries older than 12 months.
app.post("/api/cron/purge-audit-log", requireCronSecret, async (req, res) => {
  try {
    const result = await require("./routes/audit").purgeExpired();
    console.log(`[audit] retention purge removed ${result.deleted} entries older than ${result.cutoff}`);
    res.json(result);
  } catch (e) {
    console.error("[audit] retention purge failed:", String(e));
    res.status(500).json({ error: String(e) });
  }
});

// --- Protected API routes ---
// requireAuth proves who the caller is; the role gate decides what they may
// reach. Hiding a screen in the dashboard is presentation only — without
// these gates a shift manager's token can pull the full member list.
//
// shift managers (upload only) : visits, outlets, survey-templates
// dept_head and above          : operational reporting
// fb_director and above        : member PII, messaging, integrations
// general_manager and above    : club configuration and staff records
app.use("/api/integrations", requireAuth, minimumRole("general_manager"), require("./routes/integrations"));
app.use("/api/members",      requireAuth, minimumRole("fb_director"),     require("./routes/members"));
app.use("/api/message-log",  requireAuth, minimumRole("fb_director"),     require("./routes/message-log"));
app.use("/api/surveys",      requireAuth, minimumRole("dept_head"),       require("./routes/survey-log"));
app.use("/api/visits",       requireAuth,                                 require("./routes/visits"));
app.use("/api/events",       requireAuth, minimumRole("dept_head"),       require("./routes/events"));
app.use("/api/alerts",       requireAuth, minimumRole("dept_head"),       require("./routes/alerts"));
app.use("/api/training",     requireAuth, minimumRole("dept_head"),       require("./routes/training"));
app.use("/api/staff",        requireAuth, minimumRole("dept_head"),       require("./routes/staff"));
app.use("/api/servers",      requireAuth, minimumRole("dept_head"),       require("./routes/servers"));
app.use("/api/outlets",      requireAuth, writeRequires("fb_director"),   require("./routes/outlets"));
app.use("/api/survey-templates", requireAuth, writeRequires("fb_director"), require("./routes/survey-templates"));
app.use("/api/insights",     requireAuth, minimumRole("fb_director"),     require("./routes/insights"));
app.use("/api/analytics",    requireAuth, minimumRole("dept_head"),       require("./routes/analytics"));
app.use("/api/settings",     requireAuth, writeRequires("general_manager"), require("./routes/settings"));
app.use("/api/scores",       requireAuth, minimumRole("dept_head"),       require("./routes/scores"));
// Candid feedback about how a shift was managed, attributable to the person
// who wrote it. A dept_head reading complaints about their own section would
// defeat the point, so this sits at the same level as the audit trail.
app.use("/api/staff-surveys", requireAuth, minimumRole("general_manager"), require("./routes/staff-surveys"));
// The audit trail is itself sensitive — it names who accessed what.
// SMS credit — the balance, buying more, and what it was spent on. Money, so
// it sits at the same level as club configuration rather than with reporting.
app.use("/api/credit",       requireAuth, minimumRole("general_manager"), require("./routes/credit"));
// Reportable analytics and their exports. dept_head and above: this is the
// reporting the operational roles are meant to read, and the export is the same
// data they can already see on screen.
app.use("/api/reports",      requireAuth, minimumRole("dept_head"),         require("./routes/reports"));
app.use("/api/audit",        requireAuth, minimumRole("general_manager"), require("./routes/audit"));
app.use("/api/diagnostics",  requireAuth, minimumRole("general_manager"), require("./routes/diagnostics"));

// --- Static front end ---
// Both HTML files live one level up (same folder you already have). Render
// serves them from this same web service — no separate static site needed
// unless you'd rather split it that way.
app.use(express.static(path.join(__dirname, ".."), {
  setHeaders(res, filePath) {
    // Never let browsers cache the app HTML — a stale dashboard against a
    // newer backend produces maddening "my change didn't work" symptoms
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
  },
}));

// Member-facing survey link: /s/<token> -> survey-page.html. The page reads
// the token out of the URL itself (see survey-page.html's SURVEY_TOKEN line).
app.get("/s/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "survey-page.html"));
});

// Staff workday survey link: /ss/<token> -> staff-survey-page.html.
app.get("/ss/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "staff-survey-page.html"));
});

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "vero-dashboard.html"));
});

// --- Built-in scheduler for daily digest ---
const { supabase } = require("./lib/supabase");
const { notifyManagers, dashboardUrl } = require("./lib/notify");

function startDigestScheduler() {
  const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR || "7", 10);

  function msUntilNext(hour) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  async function runDigest() {
    try {
      const today = new Date().toISOString().split("T")[0];
      const url = dashboardUrl();

      const { data: unassignedAlerts } = await supabase
        .from("case_alerts")
        .select("alert_id, severity, created_at, outlets(name)")
        .eq("status", "open")
        .is("assigned_to_staff_id", null)
        .in("severity", ["medium", "high"])
        .order("created_at", { ascending: false });

      const { data: overdueTasks } = await supabase
        .from("server_tasks")
        .select("task_id, server_name, title, due_by, category")
        .eq("completed", false)
        .lt("due_by", today);

      const { data: awaitingApproval } = await supabase
        .from("server_tasks")
        .select("task_id, server_name, title, completed_at, category")
        .eq("completed", true)
        .is("approved_by", null);

      const alertCount = unassignedAlerts?.length || 0;
      const overdueCount = overdueTasks?.length || 0;
      const approvalCount = awaitingApproval?.length || 0;

      if (alertCount === 0 && overdueCount === 0 && approvalCount === 0) {
        console.log("[digest] Nothing to report, skipping.");
        return;
      }

      let body = `Daily Digest — ${CLUB_NAME}\n${"=".repeat(40)}\n\n`;

      if (alertCount > 0) {
        body += `UNASSIGNED ALERTS (${alertCount})\n${"-".repeat(30)}\n`;
        for (const a of unassignedAlerts) {
          body += `  • [${a.severity.toUpperCase()}] ${a.outlets?.name || "Unknown"} — created ${new Date(a.created_at).toLocaleDateString()}\n`;
        }
        body += "\n";
      }

      if (overdueCount > 0) {
        body += `OVERDUE TASKS (${overdueCount})\n${"-".repeat(30)}\n`;
        for (const t of overdueTasks) {
          body += `  • ${t.server_name}: ${t.title} (due ${t.due_by})\n`;
        }
        body += "\n";
      }

      if (approvalCount > 0) {
        body += `AWAITING YOUR SIGN-OFF (${approvalCount})\n${"-".repeat(30)}\n`;
        for (const t of awaitingApproval) {
          body += `  • ${t.server_name}: ${t.title} (completed ${new Date(t.completed_at).toLocaleDateString()})\n`;
        }
        body += "\n";
      }

      if (url) body += `View dashboard: ${url}\n`;

      const subject = `[Club Vero] Daily Digest: ${alertCount} unassigned, ${overdueCount} overdue, ${approvalCount} awaiting sign-off`;
      const results = await notifyManagers(subject, body);
      console.log("[digest] Sent to", results.length, "manager(s)");
    } catch (err) {
      console.error("[digest] Error:", err.message);
    }
  }

  function scheduleNext() {
    const delay = msUntilNext(DIGEST_HOUR);
    const fireAt = new Date(Date.now() + delay).toLocaleString();
    console.log(`[digest] Next digest scheduled for ${fireAt}`);
    setTimeout(() => {
      runDigest().finally(scheduleNext);
    }, delay);
  }

  scheduleNext();
}

const { startSurveyScheduler } = require("./lib/scheduler");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vero server listening on port ${PORT}`);
  startDigestScheduler();
  startSurveyScheduler();   // survey sends are driven by the time set in Settings
});
