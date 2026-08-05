// In-app survey scheduler.
//
// The send time is chosen by the club in Settings, so scheduling lives here
// rather than in an external cron. The loop re-reads the setting on every
// tick, which means a change in the UI takes effect immediately with nothing
// to redeploy.
//
// Design notes:
//   * Sends when the club's local time is at or past the configured time and
//     nothing has gone out yet today. "At or past" rather than "exactly at"
//     means a restart, a slow tick or a brief outage around the send minute
//     delays the batch rather than losing it.
//   * A date stamp (Eastern) guards against sending twice in a day, including
//     across restarts, since it lives in the database rather than in memory.
//   * The 8pm–8am blackout is enforced here too, so it holds no matter what
//     time someone manages to configure.

const { supabase } = require("./supabase");

const TICK_MS = 60_000;              // re-check every minute
const BLACKOUT_START_HOUR = 20;      // 8pm
const BLACKOUT_END_HOUR = 8;         // 8am
const CLUB_TZ = "America/New_York";

let timer = null;
let running = false;

// Club-local date and time in one pass, so the day never disagrees with the
// hour across a midnight boundary.
function clubNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CLUB_TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
  };
}

async function readSettings() {
  const { data } = await supabase.from("club_settings").select("key, value");
  const out = {};
  for (const r of data || []) out[r.key] = r.value;
  return out;
}

async function writeSetting(key, value) {
  await supabase.from("club_settings").upsert({
    key, value: String(value), updated_at: new Date().toISOString(),
  });
}

// Decide whether this tick should send. Pure, so the rules are testable
// without a database or a clock.
function shouldSend({ now, sendTime, lastSentDate }) {
  if (now.hour < BLACKOUT_END_HOUR || now.hour >= BLACKOUT_START_HOUR) {
    return { send: false, reason: "inside the 8pm–8am blackout" };
  }
  if (lastSentDate === now.date) {
    return { send: false, reason: "already sent today" };
  }
  const effective = String(sendTime || "09:30");
  const [h, m] = effective.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) {
    return { send: false, reason: `send time "${sendTime}" is not valid` };
  }
  const nowMins = now.hour * 60 + now.minute;
  const sendMins = h * 60 + m;
  if (nowMins < sendMins) {
    return { send: false, reason: `waiting for ${effective}` };
  }
  return { send: true, reason: `at or past ${effective} and nothing sent today` };
}

// Staff surveys go out after service, so they cannot share the member
// blackout — 8pm would block almost every send. They get their own quiet
// window instead: nothing before 11am (a shift is not over) and nothing from
// 11pm, so a late finish does not put a message on someone's phone at 1am.
const STAFF_QUIET_START_HOUR = 23;
const STAFF_QUIET_END_HOUR = 11;

function shouldSendStaffSurvey({ now, enabled, sendTime, lastSentDate }) {
  // Opt-in: this messages your own employees, so it stays off until a GM
  // turns it on rather than starting the moment the migration is applied.
  if (String(enabled) !== "true") {
    return { send: false, reason: "staff surveys are switched off" };
  }
  if (now.hour >= STAFF_QUIET_START_HOUR || now.hour < STAFF_QUIET_END_HOUR) {
    return { send: false, reason: "inside the 11pm–11am staff quiet window" };
  }
  if (lastSentDate === now.date) {
    return { send: false, reason: "already sent today" };
  }
  const effective = String(sendTime || "20:30");
  const [h, m] = effective.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) {
    return { send: false, reason: `staff send time "${sendTime}" is not valid` };
  }
  if (now.hour * 60 + now.minute < h * 60 + m) {
    return { send: false, reason: `waiting for ${effective}` };
  }
  return { send: true, reason: `at or past ${effective} and nothing sent today` };
}

// Staff sends are independent of the member send: one failing must not stop
// the other, so this runs on its own claim/settings keys.
async function tickStaffSurveys(now, settings) {
  const decision = shouldSendStaffSurvey({
    now,
    enabled: settings.staff_survey_enabled,
    sendTime: settings.staff_survey_send_time,
    lastSentDate: settings.staff_survey_last_sent_date,
  });
  if (!decision.send) return;

  const base = (process.env.SURVEY_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.error("[scheduler] SURVEY_BASE_URL is not set — staff survey links would be unreachable; skipping send");
    return;
  }

  // Claim the day before sending, so a mid-send crash under-sends rather than
  // messaging the whole team twice.
  await writeSetting("staff_survey_last_sent_date", now.date);

  const { performStaffSend } = require("../routes/staff-surveys");
  console.log(`[scheduler] sending staff surveys — ${decision.reason}`);
  const result = await performStaffSend(base, now.date);
  console.log("[scheduler] staff survey send finished:", JSON.stringify(result));
}

async function tick() {
  if (running) return;                 // never overlap a long send
  running = true;
  try {
    const now = clubNow();
    const settings = await readSettings();

    // Kept separate from the member send below: a failure here must not stop
    // member surveys going out, and vice versa.
    try {
      await tickStaffSurveys(now, settings);
    } catch (e) {
      console.error("[scheduler] staff survey tick failed:", String(e));
    }

    const decision = shouldSend({
      now,
      sendTime: settings.survey_send_time,
      lastSentDate: settings.last_sent_date,
    });

    // Heartbeat proves the scheduler is alive even when it decides not to send.
    await writeSetting("scheduler_heartbeat_at", new Date().toISOString());

    if (!decision.send) return;

    // Claim the day before sending. If the send throws part-way we would
    // rather under-send than send a member two surveys.
    await writeSetting("last_sent_date", now.date);

    const { performSend } = require("../routes/surveys");
    const base = (process.env.SURVEY_BASE_URL || "").replace(/\/+$/, "");
    if (!base) {
      console.error("[scheduler] SURVEY_BASE_URL is not set — survey links would be unreachable; skipping send");
      return;
    }

    console.log(`[scheduler] sending surveys — ${decision.reason}`);
    const result = await performSend(base);
    console.log("[scheduler] send finished:", JSON.stringify(result));
  } catch (e) {
    console.error("[scheduler] tick failed:", String(e));
  } finally {
    running = false;
  }
}

function startSurveyScheduler() {
  if (timer) return;
  console.log(`[scheduler] survey scheduler started — checking every ${TICK_MS / 1000}s against the send time in Settings`);
  tick();                              // catch up immediately on boot
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}

function stopSurveyScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSurveyScheduler, stopSurveyScheduler, shouldSend, shouldSendStaffSurvey, clubNow, tick };
