// Who a record is — one definition, used everywhere.
//
// This list was previously written out three times: as VALID_TYPES in
// routes/visits.js, as a check constraint in schema.sql, and as <option> tags in
// the dashboard. They had already drifted — the dropdown omitted 'golf', which
// the other two allow — and nothing anywhere said whether that was deliberate.
// Adding the same field to Members would have made it four copies.
//
// So the list lives here, the server validates against it, and the dashboard
// builds both dropdowns from it via /api/club-config. Adding a type is one edit
// plus a constraint change, and the two screens cannot disagree again.

// `selectable` is the distinction the dropdown was making silently. A golf visit
// is created by the tee sheet importer, never typed in by hand, so it is a valid
// stored value but not something to offer in a form. Recording that here means
// the omission is a documented rule rather than a discrepancy someone has to
// reverse-engineer.
const TYPES = [
  { value: "member",     label: "Member",           selectable: true,  describes: "Someone on the membership roster." },
  { value: "visitor",    label: "Visitor / Guest",  selectable: true,  describes: "A guest, or a member's visitor." },
  { value: "commercial", label: "Commercial",       selectable: true,  describes: "A corporate or trade contact." },
  { value: "other",      label: "Other",            selectable: true,  describes: "Anyone who fits none of the above." },
  { value: "golf",       label: "Golf",             selectable: false, describes: "Created by the tee sheet importer, not entered by hand." },
];

const VALUES = TYPES.map((t) => t.value);
const SELECTABLE = TYPES.filter((t) => t.selectable);
const LABELS = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));

const DEFAULT_TYPE = "member";

function isValid(value) {
  return VALUES.includes(value);
}

// Coerce to a storable value. Anything unrecognised — a stale client, a hand
// -crafted request, a CSV column with a typo — becomes the default rather than
// failing the write, because losing a member import over a spelling is a worse
// outcome than filing them under the commonest type.
function normalise(value, fallback = DEFAULT_TYPE) {
  if (value == null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (isValid(v)) return v;

  // The spellings a CRM export actually produces, mapped rather than dropped.
  const ALIASES = {
    guest: "visitor", guests: "visitor", visitors: "visitor",
    corporate: "commercial", company: "commercial", business: "commercial", trade: "commercial",
    members: "member", full: "member", social: "member",
  };
  return ALIASES[v] || fallback;
}

// Only the types a person may pick in a form. The dashboard renders its
// dropdowns from this, so a non-selectable type never appears as an option.
function selectableOptions() {
  return SELECTABLE.map((t) => ({ value: t.value, label: t.label }));
}

function labelFor(value) {
  return LABELS[value] || value || "";
}

module.exports = { TYPES, VALUES, SELECTABLE, LABELS, DEFAULT_TYPE, isValid, normalise, selectableOptions, labelFor };
