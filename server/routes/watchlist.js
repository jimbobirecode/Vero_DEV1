// Members who had a bad visit, and what happened the next time they came in.
//
// The alerts screen answers "what did we do about it". This answers "did it
// work", which is a different question and only the member can settle it. A
// case closed on Tuesday tells you a manager rang somebody; the member walking
// back in on Saturday and rating it a nine tells you it worked.
//
// Two views:
//
//   GET /api/watchlist              the club's list, longest wait first
//   GET /api/watchlist/:member_id   one member's timeline, for the point at
//                                   which they turn up again
//
// The second is the one that does the work. It is cheap enough to call when a
// visit is being logged, which is the moment somebody can still act.

const express = require("express");
const router = express.Router();
const store = require("../lib/member-watch-store");
const watch = require("../lib/member-watch");
const { auditRead, ACTIONS } = require("../lib/audit");

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

// The window and the watch length are the same number. Loading less history
// than the watch covers would grade a member against a period that starts
// after their incident, which reads as "never came back" for somebody who has
// been in every week — see the note in member-watch-store.js.
const optsFrom = (query) => {
  const watchDays = clamp(query.days, 7, 365, watch.DEFAULTS.watchDays);
  return { days: watchDays, watchDays };
};

// GET /api/watchlist?days=180
router.get("/", auditRead(ACTIONS.MEMBER_LIST_VIEWED), async (req, res) => {
  const result = await store.watchlist(optsFrom(req.query));
  if (result.error) return res.status(500).json({ error: result.error });
  res.json(result);
});

// GET /api/watchlist/:member_id
//
// 200 with standing:null for a member who has had no bad visit. Not a 404 —
// the caller is asking "is there anything I should know about this person",
// and "no" is a perfectly good answer to that.
router.get("/:member_id", async (req, res) => {
  const result = await store.standingFor(req.params.member_id, optsFrom(req.query));
  if (result.error) return res.status(500).json({ error: result.error });
  res.json(result);
});

module.exports = router;
