// Which URL, and when.
//
// The live failure: SURVEY_BASE_URL held the Render hostname while the app was
// served from a custom domain, and the Stripe success URL was built from the
// env var. Checkout returned every paying club to a URL that 404s.
//
// Two different questions, and conflating them is what broke it — a link that
// travels in a message needs a stable configured base, a redirect back to a
// browser needs the origin that browser is on.

const B = require("./base-url.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// A minimal stand-in for the Express request, which is all these functions use.
const req = (host, { proto = "https", forwarded } = {}) => ({
  protocol: proto,
  headers: forwarded ? { "x-forwarded-proto": forwarded } : {},
  get: (h) => (h.toLowerCase() === "host" ? host : undefined),
});

const withBase = (value, fn) => {
  const previous = process.env.SURVEY_BASE_URL;
  if (value === undefined) delete process.env.SURVEY_BASE_URL;
  else process.env.SURVEY_BASE_URL = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.SURVEY_BASE_URL;
    else process.env.SURVEY_BASE_URL = previous;
  }
};

const RENDER = "https://vero-walpole.onrender.com";
const DEMO = "demo.clubvero.io";

// ------------------------------------------------------- request origin ----

check("the origin comes from the request", B.requestOrigin(req(DEMO)), "https://" + DEMO);
check("a port is kept", B.requestOrigin(req("localhost:3000", { proto: "http" })), "http://localhost:3000");
check("http stays http", B.requestOrigin(req("localhost:3000", { proto: "http" })).startsWith("http://"), true);
// Render terminates TLS in front of the app, so the proxy header decides.
check("a proxied https request is https",
  B.requestOrigin(req(DEMO, { proto: "http", forwarded: "https" })), "https://" + DEMO);

check("a missing host gives nothing rather than a broken url", B.requestOrigin(req(undefined)), null);
check("no request at all gives nothing", B.requestOrigin(undefined), null);

// A crafted Host header must not be able to inject into a URL that is about to
// be handed to Stripe.
check("a host with a newline is refused", B.requestOrigin(req("evil.com\r\nX: y")), null);
check("a host with a path is refused", B.requestOrigin(req("evil.com/steal")), null);
check("a host with a space is refused", B.requestOrigin(req("evil com")), null);

// ---------------------------------------------------------- return url -----
// The bug, directly.

check("a redirect back goes to the origin the browser is on, not the env var",
  withBase(RENDER, () => B.returnUrl(req(DEMO))), "https://" + DEMO);
check("even when the env var is set and plausible",
  withBase("https://something-else.example", () => B.returnUrl(req(DEMO))), "https://" + DEMO);
check("with no env var it still works", withBase(undefined, () => B.returnUrl(req(DEMO))), "https://" + DEMO);
// Only when the request cannot answer does the configured value stand in.
check("an unusable host falls back to the configured base",
  withBase(RENDER, () => B.returnUrl(req(undefined))), RENDER);
check("and a trailing slash is trimmed off it",
  withBase(RENDER + "/", () => B.returnUrl(req(undefined))), RENDER);
check("with neither, an empty string rather than a malformed url",
  withBase(undefined, () => B.returnUrl(req(undefined))), "");

// ------------------------------------------------------------ link base ----
// The opposite preference, and for a reason: a nightly cron job has no request
// to learn the hostname from, and a member's link must work days later.

check("links that travel in a message use the configured base",
  withBase(RENDER, () => B.linkBase(req(DEMO))), RENDER);
check("falling back to the request only when it is unset",
  withBase(undefined, () => B.linkBase(req(DEMO))), "https://" + DEMO);
check("a cron job with no request still gets a base",
  withBase(RENDER, () => B.linkBase(undefined)), RENDER);

// -------------------------------------------------------------- mismatch ---
// Worth detecting because it is silent: the send succeeds and only the
// member's tap fails.

const m = withBase(RENDER, () => B.baseUrlMismatch(req(DEMO)));
check("a mismatch is detected", !!m, true);
check("and names the configured host", m.configured_host, "vero-walpole.onrender.com");
check("and the actual one", m.actual_host, DEMO);
check("and what it should be set to", m.actual, "https://" + DEMO);

check("no mismatch when they agree",
  withBase("https://" + DEMO, () => B.baseUrlMismatch(req(DEMO))), null);
check("a trailing slash is not a mismatch",
  withBase("https://" + DEMO + "/", () => B.baseUrlMismatch(req(DEMO))), null);
check("nor is a difference in case",
  withBase("https://DEMO.clubvero.io", () => B.baseUrlMismatch(req(DEMO))), null);
// A scheme difference is not worth shouting about — proxies and local dev make
// it routine, and the links still resolve.
check("a scheme difference alone is not a mismatch",
  withBase("http://" + DEMO, () => B.baseUrlMismatch(req(DEMO))), null);
check("nothing configured means nothing to disagree with",
  withBase(undefined, () => B.baseUrlMismatch(req(DEMO))), null);
check("an unusable host cannot prove a mismatch",
  withBase(RENDER, () => B.baseUrlMismatch(req(undefined))), null);
check("nonsense in the setting does not produce a false alarm",
  withBase("not a url", () => B.baseUrlMismatch(req(DEMO))), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
