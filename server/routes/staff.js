const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");
const { notifyManagers, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");
const { parseDelimited, prepareStaff } = require("../lib/roster-import");
const { ROLE_HIERARCHY } = require("../lib/security");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const VALID_ROLES = ["super_admin", "general_manager", "fb_director", "dept_head", "shift_manager", "golf_shift_manager"];

// Whether the caller may put somebody at this role.
//
// The whole router sits at dept_head, because a department head legitimately
// needs the team list to assign a case alert. Handing out roles is a different
// thing entirely: without this a dept_head could create a super_admin — for
// themselves — and read every member's contact details. Two rules:
//
//   * only general_manager and above may set a role at all, and
//   * nobody may grant a role above their own, so a general manager cannot
//     mint a super_admin either.
function roleGrantError(req, role) {
  const actor = ROLE_HIERARCHY[req.user?.role] ?? -1;
  if (actor < ROLE_HIERARCHY.general_manager) {
    return "Only a General Manager or Super Admin can set someone's role";
  }
  if ((ROLE_HIERARCHY[role] ?? 0) > actor) {
    return `You cannot give someone a role above your own (${req.user.role})`;
  }
  return null;
}

// POST /api/staff/import — bulk add team members from a pasted or uploaded
// roster. Declared before the /:id routes so "import" is not read as an id.
//
// Matching is by email, so re-uploading a corrected roster updates the same
// people rather than creating a second copy of everybody. Rows without an
// email cannot be matched, so they are only ever created — and a name-only
// row is reported as such rather than quietly duplicating on the next run.
//
// This creates roster records, not logins. A login is still created
// deliberately, one person at a time, on the User accounts panel: importing a
// spreadsheet should never mint credentials.
router.post("/import", async (req, res) => {
  const { text, default_role } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Paste the roster, or choose a file, first." });
  }
  if (default_role && !VALID_ROLES.includes(default_role)) {
    return res.status(400).json({ error: `default_role must be one of: ${VALID_ROLES.join(", ")}` });
  }
  // An import assigns roles in bulk, so it is gated exactly as setting one
  // role is. Checked against the default here and against every role the file
  // actually contains below.
  const defaultGrantErr = roleGrantError(req, default_role || "shift_manager");
  if (defaultGrantErr) return res.status(403).json({ error: defaultGrantErr });

  const parsed = parseDelimited(text);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const prepared = prepareStaff(parsed, { defaultRole: default_role || "shift_manager" });
  if (prepared.error) return res.status(400).json({ error: prepared.error });

  // Nothing is written until every role in the file is one the caller may
  // grant. A partial import that stopped halfway would leave the roster in a
  // state nobody asked for.
  for (const rec of prepared.records) {
    const err = roleGrantError(req, rec.role);
    if (err) {
      return res.status(403).json({ error: `${err}. "${rec.name}" is listed as ${rec.role}.` });
    }
  }

  const result = { total_rows: parsed.rows.length, created: 0, updated: 0, skipped: prepared.skipped };

  for (const rec of prepared.records) {
    let existing = null;
    if (rec.email) {
      // Case-insensitively, because that is how the login gate matches too.
      const { data: all } = await supabase.from("staff").select("staff_id, email");
      existing = (all || []).find((s) => (s.email || "").trim().toLowerCase() === rec.email.toLowerCase()) || null;
    }

    if (existing) {
      const { error } = await supabase
        .from("staff")
        .update({ name: rec.name, role: rec.role, active: true })
        .eq("staff_id", existing.staff_id);
      if (error) { result.skipped.push({ value: rec.name, reason: error.message }); continue; }
      result.updated++;
      continue;
    }

    const { error } = await supabase
      .from("staff")
      .insert({ name: rec.name, email: rec.email, role: rec.role });
    if (error) { result.skipped.push({ value: rec.name, reason: error.message }); continue; }

    // No servers row — see POST / above. Importing a management roster should
    // not populate the list of people credited with sales.
    result.created++;
  }

  log(req, ACTIONS.STAFF_IMPORTED, {
    target: "team_members", created: result.created, updated: result.updated, skipped: result.skipped.length,
    roles: [...new Set(prepared.records.map((r) => r.role))],
  });

  res.json(result);
});

// GET /api/staff?active=true
router.get("/", async (req, res) => {
  let query = supabase
    .from("staff")
    .select("*")
    .order("name", { ascending: true });

  if (req.query.active !== undefined) {
    query = query.eq("active", req.query.active === "true");
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ staff: data });
});

// POST /api/staff (create new staff member)
router.post("/", async (req, res, next) => {
  // Let the more-specific POST routes handle their own paths
  if (req.path === "/generate-monthly" || req.path === "/generate-analysis") return next("route");

  const { name, email, role } = req.body;

  if (!name) return res.status(400).json({ error: "name is required" });
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
  }
  const grantErr = roleGrantError(req, role);
  if (grantErr) return res.status(403).json({ error: grantErr });

  const { data, error } = await supabase
    .from("staff")
    .insert({ name, email, role })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Deliberately does NOT create a servers row.
  //
  // It used to, which put the General Manager, the F&B Director and every
  // department head in the Server dropdown when logging a visit — none of
  // whom are credited with sales in the POS. The two lists answer different
  // questions: staff is who can use the dashboard and be assigned an alert,
  // servers is who is credited with a cheque and sent a shift survey. Someone
  // who is genuinely both gets added to the roster on the Servers panel,
  // where the "credited with sales but not on your server list" prompt
  // surfaces them automatically the first time the POS names them.
  res.status(201).json(data);
});

// ---------------------------------------------------------------------------
// Server Performance Scorecard endpoints
// (placed BEFORE /:id routes so Express doesn't match them as IDs)
// ---------------------------------------------------------------------------

// GET /api/staff/leaderboard?month=2026-07
router.get("/leaderboard", async (req, res) => {
  try {
    let startDate, endDate;

    if (req.query.month) {
      // YYYY-MM format
      const [year, month] = req.query.month.split("-").map(Number);
      startDate = new Date(year, month - 1, 1).toISOString().split("T")[0];
      endDate = new Date(year, month, 0).toISOString().split("T")[0]; // last day of month
    } else {
      // Default: last 30 days
      const now = new Date();
      endDate = now.toISOString().split("T")[0];
      const past = new Date(now);
      past.setDate(past.getDate() - 30);
      startDate = past.toISOString().split("T")[0];
    }

    // Fetch visits with survey responses for the date range where server_name or server_id is set
    const { data: responses, error } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, visits!inner(server_name, server_id, spend_amount, visit_date, servers(server_id, name))")
      .gte("visits.visit_date", startDate)
      .lte("visits.visit_date", endDate);

    if (error) return res.status(500).json({ error: error.message });

    // Aggregate per server in JS — prefer server_id linkage, fall back to server_name
    const serverMap = {};

    for (const r of responses ?? []) {
      const serverId = r.visits?.server_id;
      const serverRec = r.visits?.servers;
      const name = serverRec?.name || r.visits?.server_name;
      if (!name) continue;

      const key = serverId || name;
      if (!serverMap[key]) {
        serverMap[key] = {
          server_id: serverId || null,
          server_name: name,
          nps_sum: 0,
          overall_sum: 0,
          food_sum: 0,
          service_sum: 0,
          survey_count: 0,
          total_spend: 0,
        };
      }
      const s = serverMap[key];
      s.nps_sum += r.q1_nps ?? 0;
      s.overall_sum += r.q2_overall_stars ?? 0;
      s.food_sum += r.q3_food_stars ?? 0;
      s.service_sum += r.q4_service_stars ?? 0;
      s.survey_count += 1;
      s.total_spend += r.visits?.spend_amount ?? 0;
    }

    const leaderboard = Object.values(serverMap)
      .map((s) => {
        const avg_nps = s.nps_sum / s.survey_count;
        const avg_overall = s.overall_sum / s.survey_count;
        const avg_food = s.food_sum / s.survey_count;
        const avg_service = s.service_sum / s.survey_count;
        // NPS is 0-10, map to 0-5 scale: divide by 2
        const nps_scaled = avg_nps / 2;
        const composite_score =
          nps_scaled * 0.3 + avg_overall * 0.3 + avg_food * 0.2 + avg_service * 0.2;

        return {
          server_id: s.server_id,
          server_name: s.server_name,
          avg_nps: Math.round(avg_nps * 100) / 100,
          avg_overall: Math.round(avg_overall * 100) / 100,
          avg_food: Math.round(avg_food * 100) / 100,
          avg_service: Math.round(avg_service * 100) / 100,
          composite_score: Math.round(composite_score * 100) / 100,
          survey_count: s.survey_count,
          total_spend: Math.round(s.total_spend * 100) / 100,
        };
      })
      .sort((a, b) => b.composite_score - a.composite_score);

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/generate-monthly
router.post("/generate-monthly", async (req, res) => {
  try {
    const now = new Date();
    const month = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [year, mon] = month.split("-").map(Number);
    const startDate = new Date(year, mon - 1, 1).toISOString().split("T")[0];
    const endDate = new Date(year, mon, 0).toISOString().split("T")[0];

    // Fetch visits with survey responses for the month
    const { data: responses, error } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, visits!inner(server_name, spend_amount, visit_date)")
      .gte("visits.visit_date", startDate)
      .lte("visits.visit_date", endDate)
      .not("visits.server_name", "is", null)
      .neq("visits.server_name", "");

    if (error) return res.status(500).json({ error: error.message });

    // Aggregate per server
    const serverMap = {};
    for (const r of responses ?? []) {
      const name = r.visits?.server_name;
      if (!name) continue;

      if (!serverMap[name]) {
        serverMap[name] = {
          server_name: name,
          nps_scores: [],
          overall_scores: [],
          food_scores: [],
          service_scores: [],
          comments: [],
          survey_count: 0,
        };
      }
      const s = serverMap[name];
      if (r.q1_nps != null) s.nps_scores.push(r.q1_nps);
      if (r.q2_overall_stars != null) s.overall_scores.push(r.q2_overall_stars);
      if (r.q3_food_stars != null) s.food_scores.push(r.q3_food_stars);
      if (r.q4_service_stars != null) s.service_scores.push(r.q4_service_stars);
      if (r.q5_comment) s.comments.push(r.q5_comment);
      s.survey_count += 1;
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const tasksToInsert = [];
    const aiResults = [];
    // Collected rather than only logged: a run where every model call failed
    // still writes tasks, and the person reading the screen should know the
    // wording came from the scores rather than from the analysis.
    const aiFailures = [];

    for (const s of Object.values(serverMap)) {
      const avg_nps = avg(s.nps_scores);
      const avg_overall = avg(s.overall_scores);
      const avg_food = avg(s.food_scores);
      const avg_service = avg(s.service_scores);
      const nps_scaled = avg_nps / 2;
      const composite = nps_scaled * 0.3 + avg_overall * 0.3 + avg_food * 0.2 + avg_service * 0.2;

      // Only generate for training (composite < 3.0) or recognition (composite >= 4.0 and 5+ surveys)
      let category = null;
      if (composite < 3.0) {
        category = "training";
      } else if (composite >= 4.0 && s.survey_count >= 5) {
        category = "recognition";
      }
      if (!category) continue;

      const prompt = `You are analyzing server performance at a private club based on guest survey data for ${month}.

Server: ${s.server_name}
Category: ${category}
Survey count: ${s.survey_count}
Average NPS (0-10): ${avg_nps.toFixed(2)}
Average Overall Stars (1-5): ${avg_overall.toFixed(2)}
Average Food Stars (1-5): ${avg_food.toFixed(2)}
Average Service Stars (1-5): ${avg_service.toFixed(2)}
Composite Score (0-5): ${composite.toFixed(2)}
Guest Comments: ${JSON.stringify(s.comments)}

Generate a single task for this server. For "training" category, focus on specific improvement areas based on the data. For "recognition" category, highlight specific achievements.

Respond with ONLY valid JSON (no markdown, no preamble):
{
  "title": "short actionable title",
  "description": "specific, actionable text based on actual survey data and comments",
  "key_metric": "e.g. Service score 2.1/5 -- lowest on the team"
}`;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      // The task written from the scores alone, used whenever the model does
      // not come back with something usable. server_tasks.title is NOT NULL,
      // so a task with no title is not a degraded task — it is an insert the
      // database rejects, which used to be reported to the screen as a
      // success with nothing to show for it.
      const fromScores = () => ({
        title: `${category === "training" ? "Improvement needed" : "Recognition"} for ${s.server_name}`,
        description: `Composite score: ${composite.toFixed(2)}/5 over ${s.survey_count} surveys`,
        key_metric: `${s.survey_count} surveys, composite ${composite.toFixed(2)}`,
      });

      const aiData = await aiRes.json().catch(() => ({}));

      // An API error arrives as a normal body with no content array, and
      // "{}" parses perfectly well — so catching a JSON error was never
      // enough to notice. What matters is whether a title came back.
      let parsed;
      if (aiData?.error || !aiData?.content?.[0]?.text) {
        const why = aiData?.error?.message || "the AI service returned nothing usable";
        console.error(`[analysis] ${s.server_name}: ${why} — writing the task from the scores instead`);
        aiFailures.push(`${s.server_name}: ${why}`);
        parsed = fromScores();
      } else {
        try {
          parsed = JSON.parse(aiData.content[0].text.replace(/```json|```/g, "").trim());
        } catch {
          parsed = fromScores();
        }
        if (!parsed || !parsed.title) parsed = fromScores();
      }

      const task = {
        server_name: s.server_name,
        month,
        category,
        title: parsed.title,
        description: parsed.description,
        key_metric: parsed.key_metric,
        assigned_to: null,
        completed: false,
      };

      tasksToInsert.push(task);
      aiResults.push({ server_name: s.server_name, category, composite: Math.round(composite * 100) / 100, ...parsed });
    }

    // Insert tasks into server_tasks table (fail gracefully if table doesn't exist)
    let insertedCount = 0;
    if (tasksToInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("server_tasks")
        .insert(tasksToInsert)
        .select();

      if (insertError) {
        console.error("server_tasks insert error (table may not exist):", insertError.message);
      } else {
        insertedCount = inserted?.length ?? 0;
      }
    }

    res.json({
      month,
      servers_analyzed: Object.keys(serverMap).length,
      tasks_generated: tasksToInsert.length,
      tasks_inserted: insertedCount,
      results: aiResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/generate-analysis — flexible date range analysis
router.post("/generate-analysis", async (req, res) => {
  try {
    const { start_date, end_date, label } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }

    const { data: responses, error } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, visits!inner(server_name, spend_amount, visit_date)")
      .gte("visits.visit_date", start_date)
      .lte("visits.visit_date", end_date)
      .not("visits.server_name", "is", null)
      .neq("visits.server_name", "");

    if (error) return res.status(500).json({ error: error.message });

    const serverMap = {};
    for (const r of responses ?? []) {
      const name = r.visits?.server_name;
      if (!name) continue;
      if (!serverMap[name]) {
        serverMap[name] = { server_name: name, nps_scores: [], overall_scores: [], food_scores: [], service_scores: [], comments: [], survey_count: 0 };
      }
      const s = serverMap[name];
      if (r.q1_nps != null) s.nps_scores.push(r.q1_nps);
      if (r.q2_overall_stars != null) s.overall_scores.push(r.q2_overall_stars);
      if (r.q3_food_stars != null) s.food_scores.push(r.q3_food_stars);
      if (r.q4_service_stars != null) s.service_scores.push(r.q4_service_stars);
      if (r.q5_comment) s.comments.push(r.q5_comment);
      s.survey_count += 1;
    }

    if (!Object.keys(serverMap).length) {
      return res.json({
        period: label || `${start_date} to ${end_date}`,
        month: String(start_date).slice(0, 7),
        servers_analyzed: 0, tasks_generated: 0, tasks_inserted: 0, results: [],
        note: "No completed surveys in that period name a server, so there was nothing to analyse. Check the period, and that visits are being logged with a server against them.",
      });
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const tasksToInsert = [];
    const aiResults = [];
    // Collected rather than only logged: a run where every model call failed
    // still writes tasks, and the person reading the screen should know the
    // wording came from the scores rather than from the analysis.
    const aiFailures = [];
    const periodLabel = label || `${start_date} to ${end_date}`;
    const monthKey = start_date.slice(0, 7);

    for (const s of Object.values(serverMap)) {
      const avg_nps = avg(s.nps_scores);
      const avg_overall = avg(s.overall_scores);
      const avg_food = avg(s.food_scores);
      const avg_service = avg(s.service_scores);
      const nps_scaled = avg_nps / 2;
      const composite = nps_scaled * 0.3 + avg_overall * 0.3 + avg_food * 0.2 + avg_service * 0.2;

      let category = null;
      if (composite < 3.0) {
        category = "training";
      } else if (composite >= 4.0 && s.survey_count >= 3) {
        category = "recognition";
      }
      if (!category) continue;

      if (!ANTHROPIC_API_KEY) {
        const task = {
          server_name: s.server_name, month: monthKey, category,
          title: `${category === "training" ? "Improvement needed" : "Recognition"} for ${s.server_name}`,
          description: `Composite score: ${composite.toFixed(2)}/5 over ${s.survey_count} surveys (${periodLabel})`,
          key_metric: `${s.survey_count} surveys, composite ${composite.toFixed(2)}`,
          assigned_to: null, completed: false,
        };
        tasksToInsert.push(task);
        aiResults.push({ server_name: s.server_name, category, composite: Math.round(composite * 100) / 100, ...task });
        continue;
      }

      const prompt = `You are analyzing server performance at a private club based on guest survey data for ${periodLabel}.

Server: ${s.server_name}
Category: ${category}
Survey count: ${s.survey_count}
Average NPS (0-10): ${avg_nps.toFixed(2)}
Average Overall Stars (1-5): ${avg_overall.toFixed(2)}
Average Food Stars (1-5): ${avg_food.toFixed(2)}
Average Service Stars (1-5): ${avg_service.toFixed(2)}
Composite Score (0-5): ${composite.toFixed(2)}
Guest Comments: ${JSON.stringify(s.comments)}

Generate a single task for this server. For "training" category, focus on specific improvement areas based on the data. For "recognition" category, highlight specific achievements.

Respond with ONLY valid JSON (no markdown, no preamble):
{
  "title": "short actionable title",
  "description": "specific, actionable text based on actual survey data and comments",
  "key_metric": "e.g. Service score 2.1/5 -- lowest on the team"
}`;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      });

      // The task written from the scores alone, used whenever the model does
      // not come back with something usable. server_tasks.title is NOT NULL,
      // so a task with no title is not a degraded task — it is an insert the
      // database rejects, which used to be reported to the screen as a
      // success with nothing to show for it.
      const fromScores = () => ({
        title: `${category === "training" ? "Improvement needed" : "Recognition"} for ${s.server_name}`,
        description: `Composite score: ${composite.toFixed(2)}/5 over ${s.survey_count} surveys`,
        key_metric: `${s.survey_count} surveys, composite ${composite.toFixed(2)}`,
      });

      const aiData = await aiRes.json().catch(() => ({}));

      // An API error arrives as a normal body with no content array, and
      // "{}" parses perfectly well — so catching a JSON error was never
      // enough to notice. What matters is whether a title came back.
      let parsed;
      if (aiData?.error || !aiData?.content?.[0]?.text) {
        const why = aiData?.error?.message || "the AI service returned nothing usable";
        console.error(`[analysis] ${s.server_name}: ${why} — writing the task from the scores instead`);
        aiFailures.push(`${s.server_name}: ${why}`);
        parsed = fromScores();
      } else {
        try {
          parsed = JSON.parse(aiData.content[0].text.replace(/```json|```/g, "").trim());
        } catch {
          parsed = fromScores();
        }
        if (!parsed || !parsed.title) parsed = fromScores();
      }

      tasksToInsert.push({
        server_name: s.server_name, month: monthKey, category,
        title: parsed.title, description: parsed.description, key_metric: parsed.key_metric,
        assigned_to: null, completed: false,
      });
      aiResults.push({ server_name: s.server_name, category, composite: Math.round(composite * 100) / 100, ...parsed });
    }

    let insertedCount = 0;
    const errors = [];
    if (tasksToInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase.from("server_tasks").insert(tasksToInsert).select();
      if (insertError) {
        // This used to be logged and nothing more, so the screen reported the
        // number of tasks the run *meant* to write and then showed an empty
        // list. A run that saved nothing is a failed run, and says so.
        console.error("server_tasks insert error:", insertError.message);
        errors.push(`The tasks could not be saved: ${insertError.message}`);
      } else {
        insertedCount = inserted?.length ?? 0;
      }
    }
    if (aiFailures.length) {
      errors.push(
        `The AI service could not be reached for ${aiFailures.length} of ${tasksToInsert.length} ` +
        `task${tasksToInsert.length === 1 ? "" : "s"}; ${tasksToInsert.length === 1 ? "it was" : "those were"} ` +
        `written from the scores instead. (${aiFailures[0]})`
      );
    }

    // Why a run can analyse servers and still produce nothing: a task is only
    // raised for somebody clearly struggling or clearly excelling. Everybody
    // in between is the normal case, and silence there reads as a broken
    // button rather than as good news.
    let note = null;
    if (!tasksToInsert.length) {
      note = `Analysed ${Object.keys(serverMap).length} server${Object.keys(serverMap).length === 1 ? "" : "s"} ` +
        `and found none needing attention: a training task is raised below a composite of 3.0, and recognition ` +
        `at 4.0 or above with at least 3 surveys. Everyone fell between the two.`;
    }

    res.json({
      period: periodLabel,
      // The month the tasks were filed under. The screen filters by month and
      // defaults to today, so analysing an earlier period wrote tasks that
      // were then never asked for.
      month: monthKey,
      servers_analyzed: Object.keys(serverMap).length,
      tasks_generated: tasksToInsert.length,
      tasks_inserted: insertedCount,
      results: aiResults,
      ...(note ? { note } : {}),
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/tasks?month=2026-07
router.get("/tasks", async (req, res) => {
  try {
    let query = supabase
      .from("server_tasks")
      .select("*")
      .order("category", { ascending: true })
      .order("server_name", { ascending: true });

    if (req.query.month) {
      query = query.eq("month", req.query.month);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tasks: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/staff/tasks/:id
router.patch("/tasks/:id", async (req, res) => {
  try {
    const { completed, assigned_to, due_by } = req.body;
    const updates = {};

    if (completed !== undefined) {
      updates.completed = completed;
      if (completed) {
        updates.completed_at = new Date().toISOString();
      }
    }
    if (assigned_to !== undefined) {
      updates.assigned_to = assigned_to;
    }
    if (due_by !== undefined) {
      updates.due_by = due_by;
    }

    let data, error;
    ({ data, error } = await supabase
      .from("server_tasks")
      .update(updates)
      .eq("task_id", req.params.id)
      .select()
      .single());

    if (error && error.message && (error.message.includes("due_by") || error.message.includes("approved"))) {
      delete updates.due_by;
      ({ data, error } = await supabase
        .from("server_tasks")
        .update(updates)
        .eq("task_id", req.params.id)
        .select()
        .single());
    }

    if (error) return res.status(500).json({ error: error.message });

    if (completed && data) {
      const url = dashboardUrl();
      const subject = `[Club Vero] Task completed — awaiting your sign-off`;
      const body = `A task has been marked as completed and needs your approval.\n\nServer: ${data.server_name}\nTask: ${data.title}\nCategory: ${data.category}\n\nPlease review and sign off on this task.${url ? `\n\nView in dashboard: ${url}` : ""}\n\n${CLUB_NAME}`;
      notifyManagers(subject, body).catch((e) =>
        console.error("Task completion notification failed:", e.message)
      );
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staff/tasks/:id/approve — manager sign-off on a completed task
router.put("/tasks/:id/approve", async (req, res) => {
  try {
    const { staff_id } = req.body;
    if (!staff_id) return res.status(400).json({ error: "staff_id is required" });

    const { data: staff } = await supabase
      .from("staff")
      .select("staff_id, name, role")
      .eq("staff_id", staff_id)
      .maybeSingle();

    if (!staff) return res.status(404).json({ error: "Staff member not found" });
    if (!["super_admin", "general_manager", "fb_director"].includes(staff.role)) {
      return res.status(403).json({ error: "Only managers can approve tasks" });
    }

    const { data: task } = await supabase
      .from("server_tasks")
      .select("task_id, completed, approved_by")
      .eq("task_id", req.params.id)
      .maybeSingle();

    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!task.completed) return res.status(400).json({ error: "Task must be completed before approval" });
    if (task.approved_by) return res.status(400).json({ error: "Task is already approved" });

    const { data, error } = await supabase
      .from("server_tasks")
      .update({ approved_by: staff_id, approved_at: new Date().toISOString() })
      .eq("task_id", req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Parameterized routes (must come AFTER named routes above)
// ---------------------------------------------------------------------------

// PUT /api/staff/:id
router.put("/:id", async (req, res) => {
  const { name, email, role, active } = req.body;

  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
  }
  if (role !== undefined) {
    const grantErr = roleGrantError(req, role);
    if (grantErr) return res.status(403).json({ error: grantErr });
  }

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) updates.role = role;
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from("staff")
    .update(updates)
    .eq("staff_id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (role !== undefined) {
    log(req, ACTIONS.ROLE_CHANGED, { staff_id: req.params.id, new_role: role });
  }

  // No longer mirrored into servers. The two lists are separate people as
  // often as they are the same one, and deactivating a login should not
  // quietly take somebody off the roster who is still working the floor.
  res.json(data);
});

// DELETE /api/staff/:id — soft-delete
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("staff")
    .update({ active: false })
    .eq("staff_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  // Does not deactivate a servers row. Removing somebody's dashboard access
  // is not the same as taking them off the roster — a shift manager who
  // leaves the management team may still be serving.
  res.json({ deleted: true });
});

// POST /api/staff/seed-leaderboard — insert sample visits + survey responses
router.post("/seed-leaderboard", async (req, res) => {
  try {
    const { data: outlets } = await supabase.from("outlets").select("outlet_id, name");
    if (!outlets || !outlets.length) return res.status(400).json({ error: "No outlets found — seed outlets first" });

    const outletMap = {};
    for (const o of outlets) outletMap[o.name] = o.outlet_id;
    const fallbackOutlet = outlets[0].outlet_id;

    // Ensure sample members exist
    const sampleMembers = [
      { member_id: "SEED01", first_name: "John",    last_name: "Mitchell",  phone_number: "+16105559001", email_address: "jmitchell@example.com", comm_preference: "sms" },
      { member_id: "SEED02", first_name: "Lisa",    last_name: "Crawford",  phone_number: "+16105559002", email_address: "lcrawford@example.com", comm_preference: "email" },
      { member_id: "SEED03", first_name: "Mark",    last_name: "Reynolds",  phone_number: "+16105559003", email_address: "mreynolds@example.com", comm_preference: "sms" },
      { member_id: "SEED04", first_name: "Diana",   last_name: "Park",      phone_number: "+16105559004", email_address: "dpark@example.com",     comm_preference: "sms" },
      { member_id: "SEED05", first_name: "Greg",    last_name: "Sullivan",  phone_number: "+16105559005", email_address: "gsullivan@example.com", comm_preference: "email" },
      { member_id: "SEED06", first_name: "Rachel",  last_name: "Torres",    phone_number: "+16105559006", email_address: "rtorres@example.com",   comm_preference: "sms" },
      { member_id: "SEED07", first_name: "Brian",   last_name: "Hughes",    phone_number: "+16105559007", email_address: "bhughes@example.com",   comm_preference: "sms" },
      { member_id: "SEED08", first_name: "Angela",  last_name: "Foster",    phone_number: "+16105559008", email_address: "afoster@example.com",   comm_preference: "email" },
      { member_id: "SEED09", first_name: "Kevin",   last_name: "Barnes",    phone_number: "+16105559009", email_address: "kbarnes@example.com",   comm_preference: "sms" },
      { member_id: "SEED10", first_name: "Megan",   last_name: "Cole",      phone_number: "+16105559010", email_address: "mcole@example.com",     comm_preference: "sms" },
      { member_id: "SEED11", first_name: "Peter",   last_name: "Lawson",    phone_number: "+16105559011", email_address: "plawson@example.com",   comm_preference: "sms" },
      { member_id: "SEED12", first_name: "Sandra",  last_name: "Kim",       phone_number: "+16105559012", email_address: "skim2@example.com",     comm_preference: "email" },
    ];

    await supabase.from("members").upsert(sampleMembers, { onConflict: "member_id" });

    // Sample server performance profiles — mix of strong, average, and weak
    const servers = [
      { name: "Jessica",   profile: "star"   },
      { name: "Marcus",    profile: "strong"  },
      { name: "Olivia",    profile: "solid"   },
      { name: "James",     profile: "average" },
      { name: "Tyler",     profile: "below"   },
      { name: "Brittany",  profile: "weak"    },
    ];

    const profiles = {
      star:    { nps: [9,10,9,10,8], overall: [5,5,4,5,5], food: [5,4,5,5,4], service: [5,5,5,4,5], comments: ["Absolutely wonderful experience","Jessica is always outstanding","Best service at the club","She remembers our names every time","Perfect evening"] },
      strong:  { nps: [8,9,7,8,9],   overall: [4,5,4,4,5], food: [4,4,5,4,4], service: [5,4,4,5,4], comments: ["Marcus is great","Really attentive service","Good meal overall","Always friendly","Solid experience"] },
      solid:   { nps: [7,8,7,6,8],   overall: [4,4,3,4,4], food: [4,3,4,4,3], service: [4,4,3,4,4], comments: ["Good service","Nice dinner","Enjoyable evening","Everything was fine","Pleasant as always"] },
      average: { nps: [6,5,7,5,6],   overall: [3,3,4,3,3], food: [3,3,3,4,3], service: [3,3,3,3,4], comments: ["Service was ok","Nothing special","Decent meal","Could be better","Average experience"] },
      below:   { nps: [4,5,3,4,5],   overall: [2,3,2,3,2], food: [3,2,3,2,3], service: [2,2,3,2,2], comments: ["Had to flag him down twice","Slow service","Forgot our appetizer order","Seemed distracted","Long wait between courses"] },
      weak:    { nps: [2,3,1,3,2],   overall: [1,2,2,1,2], food: [2,1,2,2,1], service: [1,2,1,2,1], comments: ["Terrible experience","Food came out cold","Never checked on us","Wrong order twice","Would not sit in her section again"] },
    };

    // Spread the sample across whatever outlets this club actually has,
    // rather than names belonging to one particular club.
    const outletNames = outlets.map((o) => o.name);
    const now = new Date();
    let visitCount = 0;
    let surveyCount = 0;

    for (let si = 0; si < servers.length; si++) {
      const server = servers[si];
      const prof = profiles[server.profile];

      for (let j = 0; j < prof.nps.length; j++) {
        const memberIdx = (si * prof.nps.length + j) % sampleMembers.length;
        const member = sampleMembers[memberIdx];
        const outletName = outletNames[j % outletNames.length];
        const outletId = outletMap[outletName] || fallbackOutlet;
        const daysAgo = j * 3 + si;
        const visitDate = new Date(now);
        visitDate.setDate(visitDate.getDate() - daysAgo);
        const dateStr = visitDate.toISOString().split("T")[0];
        const spend = 50 + Math.round(Math.random() * 150);

        const { data: visit, error: vErr } = await supabase.from("visits").insert({
          member_id: member.member_id,
          outlet_id: outletId,
          visit_date: dateStr,
          spend_amount: spend,
          server_name: server.name,
          qualifies: true,
          survey_sent_at: new Date(visitDate.getTime() + 3600000).toISOString(),
        }).select("visit_id").single();

        if (vErr) continue;
        visitCount++;

        const token = `seed-lb-${server.name.toLowerCase()}-${j}-${Date.now()}`;
        const { error: sErr } = await supabase.from("survey_responses").insert({
          visit_id: visit.visit_id,
          survey_token: token,
          q1_nps: prof.nps[j],
          q2_overall_stars: prof.overall[j],
          q3_food_stars: prof.food[j],
          q4_service_stars: prof.service[j],
          q5_comment: prof.comments[j],
          submitted_at: new Date(visitDate.getTime() + 7200000).toISOString(),
          is_complete: true,
        });

        if (!sErr) surveyCount++;
      }
    }

    res.json({ seeded: true, visits_created: visitCount, surveys_created: surveyCount, servers: servers.map(s => s.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
