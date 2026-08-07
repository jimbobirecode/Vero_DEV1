// Which URL to use, and when.
//
// There are two different questions here and conflating them is what broke the
// return from Stripe Checkout:
//
//   Links we SEND OUT — survey links in an SMS or email — must be absolute and
//   stable, and are often built by a cron job that has no HTTP request at all.
//   They come from SURVEY_BASE_URL.
//
//   Redirects BACK TO A BROWSER — the Stripe success and cancel URLs — must
//   return the person to the origin they are actually on. This deployment is
//   served at a custom domain while SURVEY_BASE_URL still held the Render
//   hostname, so Checkout sent everyone to a URL that 404s. The request knows
//   where the browser came from; the env var does not.
//
// Keeping both in one file makes the distinction hard to miss, and gives one
// place to notice when the configured base disagrees with reality — which is
// worth knowing, because the same wrong value is going out in survey links.

// Only characters that can legitimately appear in an authority. Rejecting the
// rest stops a crafted Host header from injecting a newline or a path segment
// into a URL that is about to be handed to Stripe.
const SAFE_HOST = /^[A-Za-z0-9._~-]+(:\d+)?$/;

function trimSlashes(url) {
  return String(url || "").replace(/\/+$/, "");
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

// Where the browser actually is, according to the request.
//
// Render terminates TLS in front of the app, so the scheme comes from
// x-forwarded-proto — `req.protocol` already accounts for that because
// index.js sets `trust proxy`. Returns null rather than a malformed URL if the
// Host header is missing or does not look like a host.
function requestOrigin(req) {
  const host = req?.get?.("host");
  if (!host || !SAFE_HOST.test(host)) return null;
  const proto = req.protocol === "https" || req.headers?.["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

// For anything the browser will be redirected back to.
//
// The request wins. SURVEY_BASE_URL is only a fallback for the case where the
// Host header is unusable, because a wrong-but-configured value is exactly the
// failure this function exists to avoid.
function returnUrl(req) {
  return requestOrigin(req) || trimSlashes(process.env.SURVEY_BASE_URL) || "";
}

// For links that travel in a message.
//
// SURVEY_BASE_URL wins here: a nightly cron job has no request to learn the
// public hostname from, and a member's survey link has to work days later.
function linkBase(req) {
  return trimSlashes(process.env.SURVEY_BASE_URL) || requestOrigin(req) || "";
}

// Does the configured base actually match where this deployment is served?
//
// A mismatch is not cosmetic. Every survey link sent to a member is built from
// SURVEY_BASE_URL, so if it names a hostname that no longer resolves, those
// links are dead — and nothing in the product would say so, because the send
// succeeds and only the member's tap fails.
function baseUrlMismatch(req) {
  const configured = trimSlashes(process.env.SURVEY_BASE_URL);
  if (!configured) return null;

  const actual = requestOrigin(req);
  if (!actual) return null;

  const configuredHost = hostOf(configured);
  const actualHost = hostOf(actual);
  if (!configuredHost || !actualHost || configuredHost === actualHost) return null;

  return { configured, configured_host: configuredHost, actual, actual_host: actualHost };
}

module.exports = { requestOrigin, returnUrl, linkBase, baseUrlMismatch, trimSlashes, hostOf };
