// Metering and pricing for SMS, so the club can be back charged for what it
// actually sent.
//
// The whole feature rests on one fact: carriers bill per *segment*, not per
// message. A 155-character message is one segment. Add a single character that
// GSM-7 cannot represent — a curly apostrophe, an em dash, an emoji — and the
// entire message drops to UCS-2, where a segment holds 70 characters instead of
// 160. The same sentence then costs three segments. Billing that counts
// messages instead of segments is not slightly wrong, it is wrong by 200% on
// exactly the messages a club is most likely to reword.
//
// So this file does two separable jobs, both pure functions over plain data:
//
//   1. Metering  — how many segments a body costs, and in which encoding.
//   2. Pricing   — what those segments are worth, at the rate in force.
//
// Nothing here touches the database or the network. senders.js calls it at send
// time and stores the result on the message_log row; lib/sms-credit.js turns
// that into the amount debited from the club's prepaid balance. Keeping it
// pure is what makes a charge reproducible six months later.

// ---------------------------------------------------------------- metering --

// GSM 03.38 basic set — one septet each. The escape (0x1B) is present in the
// standard's table but is never a message character on its own; it prefixes the
// extension characters below.
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

// GSM 03.38 extension table — two septets each, because they travel as an
// escape byte followed by the character. The euro sign is the one most people
// are surprised by; it costs double even though it looks unremarkable.
const GSM_EXTENDED = new Set("\f^{}\\[~]|€");

// Capacities, in the units of the encoding.
//
// A single-part message uses the whole payload. A concatenated one gives up six
// bytes of every part to the User Data Header that tells the handset how to
// reassemble them, which is where 153 and 67 come from. This is why a message
// that is one character too long costs two segments and not one and a bit.
const GSM7_SINGLE = 160;
const GSM7_MULTI = 153;
const UCS2_SINGLE = 70;
const UCS2_MULTI = 67;

// What one character costs in GSM-7, or null if GSM-7 cannot carry it at all.
function septetCost(ch) {
  if (GSM_BASIC.has(ch)) return 1;
  if (GSM_EXTENDED.has(ch)) return 2;
  return null;
}

// Which encoding the carrier will use. One unrepresentable character anywhere
// in the body forces the whole message to UCS-2 — the encoding is chosen per
// message, never per character.
function encodingFor(text) {
  const body = text == null ? "" : String(text);
  for (const ch of body) {
    if (septetCost(ch) === null) return "ucs2";
  }
  return "gsm7";
}

// Greedy packing into fixed-capacity segments, given each unit's width.
//
// The naive form of this is Math.ceil(total / capacity), and it is subtly
// wrong: a two-unit item — a GSM-7 extension character, or an emoji's surrogate
// pair — is never split across a segment boundary. When one will not fit, the
// segment is left one unit short and the item starts the next. Over a batch
// send the difference is small, but it is real money and it is always in the
// carrier's favour, so it is worth counting properly.
function packSegments(widths, capacity) {
  let segments = 1;
  let used = 0;
  for (const w of widths) {
    if (used + w > capacity) {
      segments++;
      used = w;
    } else {
      used += w;
    }
  }
  return segments;
}

// The unit widths of a body under a given encoding.
//
// UCS-2 counts 16-bit code units, which is why this walks by code point and
// charges 2 for anything outside the Basic Multilingual Plane. An emoji is one
// character to a human, one code point to `for...of`, and two units to the
// carrier; only the last of those is billable.
function unitWidths(body, encoding) {
  const widths = [];
  for (const ch of body) {
    widths.push(
      encoding === "gsm7" ? septetCost(ch) : (ch.codePointAt(0) > 0xffff ? 2 : 1)
    );
  }
  return widths;
}

// Meter one message body.
//
// Returns the encoding, the billable unit count, the segment count, and how
// many units of headroom remain before the next segment starts. The headroom is
// what makes this useful before a send rather than only after one: it is the
// difference between "this wording is fine" and "adding the club's full name
// doubles the bill for every survey".
function meter(text) {
  const body = text == null ? "" : String(text);

  // Nothing to send is nothing to charge for. A blank body is an upstream bug,
  // but it must not become an invoice line.
  if (body.length === 0) {
    return { encoding: "gsm7", units: 0, segments: 0, capacity: GSM7_SINGLE, headroom: GSM7_SINGLE };
  }

  const encoding = encodingFor(body);
  const widths = unitWidths(body, encoding);
  const units = widths.reduce((a, b) => a + b, 0);

  const single = encoding === "gsm7" ? GSM7_SINGLE : UCS2_SINGLE;
  const multi = encoding === "gsm7" ? GSM7_MULTI : UCS2_MULTI;

  const segments = units <= single ? 1 : packSegments(widths, multi);
  const capacity = segments === 1 ? single : multi * segments;

  return { encoding, units, segments, capacity, headroom: capacity - units };
}

// The character that forced a message to UCS-2, if one did.
//
// When a statement shows a club paying triple for its golf survey, the next
// question is always "why", and the answer is one character somewhere in the
// body. Returning it turns an unexplainable line item into a one-word fix.
function offendingCharacters(text) {
  const body = text == null ? "" : String(text);
  const found = new Map();
  for (const ch of body) {
    if (septetCost(ch) === null && !found.has(ch)) {
      found.set(ch, "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
    }
  }
  return [...found].map(([character, code_point]) => ({ character, code_point }));
}

// ----------------------------------------------------------------- pricing --

// Settings keys, read from club_settings. All are strings there, as that table
// stores everything as text.
const SETTING_KEYS = {
  RATE: "sms_rate_cents_per_segment",
  MARKUP: "sms_markup_pct",
  CURRENCY: "sms_billing_currency",
};

// Deliberately no default rate.
//
// Inventing one would mean every message priced at a plausible-looking but
// fictional cost, and a plausible wrong number is far harder to catch than an
// obviously missing one. Zero is self-evidently unconfigured, and the credit
// screen says so in as many words rather than quietly deducting nothing.
const DEFAULT_RATE_CENTS = 0;

function numeric(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : fallback;
}

// The rate card in force, resolved from settings.
//
// Two numbers rather than one because they answer different questions: `rate`
// is what the carrier charges Vero, `markup_pct` is Vero's margin. Keeping them
// apart means a club can be shown a pass-through rate, or a marked-up one, or
// the margin can be changed without losing what the underlying cost was.
function rateCard(settings = {}) {
  const rate = Math.max(0, numeric(settings[SETTING_KEYS.RATE], DEFAULT_RATE_CENTS));
  const markup = Math.max(0, numeric(settings[SETTING_KEYS.MARKUP], 0));

  return {
    rate_cents_per_segment: rate,
    markup_pct: markup,
    // Six decimal places of a cent. Carrier prices run to fractions of a cent,
    // and rounding each message to a whole one would deduct $0.01 for something
    // that cost $0.0079 — a 27% overcharge on every message a club sends.
    // Rounding happens when a balance is displayed, never when it is deducted.
    unit_price_cents: round6(rate * (1 + markup / 100)),
    currency: settings[SETTING_KEYS.CURRENCY] || "USD",
    configured: rate > 0,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Round to whole cents, half away from zero.
//
// The only place rounding is allowed. Everything upstream carries full
// precision; this runs once, on a total that is about to be invoiced.
function toCents(n) {
  return Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;
}

// What one metered message is worth at a given rate card. The unit price is
// returned alongside the amount so the caller can store it on the row: an
// invoice must be reproducible from what was true at send time, not from
// whatever the rate happens to be when someone reopens the statement.
function priceMessage(metered, card) {
  const segments = metered?.segments ?? 0;
  return {
    segments,
    unit_price_cents: card.unit_price_cents,
    billable_cents: round6(segments * card.unit_price_cents),
  };
}

// Meter and price in one call — the shape senders.js stores on message_log.
function meterAndPrice(body, settings = {}) {
  const metered = meter(body);
  const card = rateCard(settings);
  const priced = priceMessage(metered, card);
  return {
    segments: priced.segments,
    encoding: metered.encoding,
    units: metered.units,
    headroom: metered.headroom,
    unit_price_cents: priced.unit_price_cents,
    billable_cents: priced.billable_cents,
  };
}

// The post-pay statement that used to live here — monthly rollups, closing a
// period, drift against an invoiced figure — is gone. Billing is prepaid now:
// see lib/sms-credit.js for the balance, the hard stop, and the ledger that
// replaced it. What remains above is metering, which prepaid needs just as
// much as post-pay did: a two-segment message must debit twice what a
// one-segment message does, and that is decided here.

module.exports = {
  // metering
  meter, encodingFor, offendingCharacters,
  // pricing
  rateCard, priceMessage, meterAndPrice, toCents, round6,
  // constants, exported for tests
  SETTING_KEYS, GSM7_SINGLE, GSM7_MULTI, UCS2_SINGLE, UCS2_MULTI,
};
