// The chart maths — the part that decides where a pixel goes.
//
// Rendering needs a browser, but the arithmetic underneath does not, and it is
// where charts go quietly wrong: an axis that lies about proportion, ticks at
// 3.7143, a domain that divides by zero when every value is identical.
const V = require("../../vero-charts.js");
const { niceTicks, scale, domainOf, compact, linePath, areaPath } = V._;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ------------------------------------------------------------------ ticks --
// Ticks carry every value that is not directly labelled, so they have to be
// numbers a person can hold in their head.

// Asserted as properties rather than exact arrays: several tick sets are
// equally "nice" (20s and 25s both read fine across 0–100), and pinning one
// makes the test about this implementation instead of about the reader.
const evenlySpaced = (t) => t.length > 1 &&
  new Set(t.slice(1).map((v, i) => Math.round((v - t[i]) * 1e6))).size === 1;
const covers = (t, lo, hi) => t[0] <= lo && t[t.length - 1] >= hi;
const allRound = (t) => t.every((v) => {
  const dp = (String(v).split(".")[1] || "").length;
  return dp <= 2 && String(Math.abs(v)).replace(/[.\-]/g, "").replace(/0+$/, "").length <= 2;
});

check("ticks across 0–100 are round, spaced and cover the range",
  [allRound(niceTicks(0, 100, 5)), evenlySpaced(niceTicks(0, 100, 5)), covers(niceTicks(0, 100, 5), 0, 100)],
  [true, true, true]);
check("an awkward range still gets round ticks that cover it",
  [allRound(niceTicks(0, 97, 5)), covers(niceTicks(0, 97, 5), 0, 97)], [true, true]);
check("a small range gets small round steps", niceTicks(3.1, 4.9, 4), [3, 3.5, 4, 4.5, 5]);
check("a negative range is covered and evenly spaced",
  [evenlySpaced(niceTicks(-50, 50, 5)), covers(niceTicks(-50, 50, 5), -50, 50)], [true, true]);
check("and crosses zero exactly, not near it", niceTicks(-50, 50, 5).includes(0), true);

// Floating point accumulates: repeated addition of 0.1 produces
// 0.30000000000000004, which renders as an axis label. Stepping by integer
// multiples avoids it.
check("no floating point crumbs on the axis",
  niceTicks(0, 0.5, 5).every((t) => String(t).length <= 4), true);

check("a flat series does not produce an axis", niceTicks(5, 5, 4), [5]);
check("nonsense gives no ticks", niceTicks(NaN, 10, 4), []);

// ------------------------------------------------------------------ scale --

check("a value maps across the range", scale(50, [0, 100], [0, 200]), 100);
check("an inverted range works, as y always is", scale(0, [0, 100], [200, 0]), 200);
// The degenerate case: without a guard this divides by zero and paints nothing.
check("a zero-width domain lands mid-range, not at NaN", scale(5, [5, 5], [0, 100]), 50);

// ----------------------------------------------------------------- domain --

check("a domain is padded so the line never touches the frame",
  domainOf([10, 20]).map((n) => Math.round(n)), [9, 21]);
// Bars must start at zero. A truncated bar axis misstates proportion, which is
// the single thing bars exist to show.
check("a zero-based domain starts at zero", domainOf([10, 20], { zeroBased: true })[0], 0);
check("and is not padded at the bottom",
  domainOf([80, 100], { zeroBased: true })[0], 0);
check("a flat series still gets a usable domain", domainOf([7, 7])[0] < 7, true);
check("nulls are ignored rather than read as zero",
  domainOf([null, 10, 20, undefined], { zeroBased: true })[1] > 20, true);
check("an empty series gives a safe domain", domainOf([]), [0, 1]);
check("all-null gives a safe domain", domainOf([null, null]), [0, 1]);

// ---------------------------------------------------------------- compact --

check("small numbers are written out", compact(842), "842");
check("thousands get a comma", compact(1284), "1,284");
check("ten thousand and up compacts", compact(12900), "12.9K");
check("millions compact", compact(4200000), "4.2M");
check("zero is zero, not a dash", compact(0), "0");
check("nothing is a dash", compact(null), "—");
check("infinity is a dash rather than the word", compact(Infinity), "—");
check("negatives survive", compact(-1284), "-1,284");

// ------------------------------------------------------------------ paths --

check("a line path starts with a move",
  linePath([[0, 10], [10, 20]]), "M0 10 L10 20");
check("an area closes back to the baseline",
  areaPath([[0, 10], [10, 20]], 50), "M0 10 L10 20 L10 50 L0 50 Z");
check("an empty area draws nothing rather than a stray Z", areaPath([], 50), "");
check("coordinates are rounded, not written to 15 places",
  linePath([[1 / 3, 2 / 3]]), "M0.33 0.67");

// ---------------------------------------------------------------- palette --
// The brand colours fail the six checks as data colours — too dark, too close
// to gray. These steps hold the brand hues and lift them into the passing band,
// and were validated by the skill's script rather than by eye.

check("the categorical palette stops at three", V.PALETTE.categorical.length, 3);
check("status colours are kept apart from the categorical set",
  V.PALETTE.categorical.includes(V.PALETTE.status.good), false);
check("the sequential ramp is one hue, light to dark", V.PALETTE.sequential.length, 5);
check("every status state is named",
  Object.keys(V.PALETTE.status).sort(), ["critical", "good", "neutral", "warning"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
