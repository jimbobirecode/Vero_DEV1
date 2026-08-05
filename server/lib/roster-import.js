// Bulk import for the two staff rosters: team members (dashboard logins and
// case-alert assignment) and servers (credited with sales, sent shift
// surveys). Adding either one at a time is fine for a new starter and awful
// for a season's roster.
//
// Parsing is shared with nothing else on purpose — the member import parses
// a PDF table with its own quirks, and folding the two together would make
// each one worse. What is shared is the shape of the answer: every row is
// either applied or reported with a row number and a reason, so an import
// never silently drops people.

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES = ["super_admin", "general_manager", "fb_director", "dept_head", "shift_manager", "golf_shift_manager"];

// What people actually type in a spreadsheet. Anything unrecognised is
// reported rather than guessed at — quietly turning "Manager" into
// general_manager would hand out the keys to the club.
const ROLE_ALIASES = {
  super_admin: ["super_admin", "superadmin", "super admin", "admin", "administrator", "owner"],
  general_manager: ["general_manager", "generalmanager", "general manager", "gm"],
  fb_director: ["fb_director", "fbdirector", "f&b director", "f and b director", "food and beverage director", "fb", "f&b"],
  dept_head: ["dept_head", "depthead", "department head", "dept head", "head of department", "hod", "manager"],
  shift_manager: ["shift_manager", "shiftmanager", "shift manager", "shift lead", "supervisor"],
  golf_shift_manager: ["golf_shift_manager", "golf shift manager", "golf manager", "golf shift lead", "pro shop manager"],
};

function canonicalRole(value) {
  const v = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  for (const [role, alts] of Object.entries(ROLE_ALIASES)) {
    if (alts.includes(v)) return role;
  }
  return undefined;   // present but not recognised — distinct from absent
}

// --- Delimited text ---------------------------------------------------------

// Splits one line, honouring double quotes so a name like "Smith, John" or a
// quoted address survives. Not a full CSV parser — it does not handle a
// newline inside a quoted field, which a roster export does not produce.
function splitLine(line, delimiter) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
      continue;
    }
    if (!quoted && ch === delimiter) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(headerLine) {
  const counts = [
    [",", (headerLine.match(/,/g) || []).length],
    ["\t", (headerLine.match(/\t/g) || []).length],
    [";", (headerLine.match(/;/g) || []).length],
    ["|", (headerLine.match(/\|/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function normaliseHeader(h) {
  return String(h).trim().toLowerCase().replace(/^﻿/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// text -> { headers, rows: [{ values, line }] }
function parseDelimited(text) {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l, i) => ({ raw: l, line: i + 1 }))
    .filter((l) => l.raw.trim());

  if (!lines.length) return { headers: [], rows: [], error: "The file is empty." };

  const delimiter = detectDelimiter(lines[0].raw);
  const headers = splitLine(lines[0].raw, delimiter).map(normaliseHeader);

  const rows = lines.slice(1).map((l) => ({
    values: splitLine(l.raw, delimiter),
    line: l.line,
  }));

  return { headers, rows, delimiter };
}

function mapColumns(headers, aliases) {
  const map = {};
  for (const [field, alts] of Object.entries(aliases)) {
    const idx = headers.findIndex((h) => alts.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

const at = (row, idx) => (idx === undefined ? "" : String(row.values[idx] ?? "").trim());

// --- Team members -----------------------------------------------------------

const STAFF_ALIASES = {
  name: ["name", "full_name", "fullname", "staff_name", "employee", "employee_name"],
  first_name: ["first_name", "firstname", "first", "forename", "given_name"],
  last_name: ["last_name", "lastname", "last", "surname", "family_name"],
  email: ["email", "email_address", "e_mail", "work_email"],
  role: ["role", "job_role", "access", "access_level", "permission", "permissions", "title", "position"],
};

// defaultRole: what a row with no role column gets. The caller passes the
// least-privileged role deliberately — a roster is a list of people, not a
// grant of access, and someone silently imported as a general manager can
// read every member's contact details.
function prepareStaff({ headers, rows }, { defaultRole = "shift_manager" } = {}) {
  const col = mapColumns(headers, STAFF_ALIASES);

  if (col.name === undefined && col.first_name === undefined) {
    return {
      error: `Could not find a name column. Found: ${headers.join(", ") || "(nothing)"}. Needs "name", or "first_name" and "last_name".`,
    };
  }

  const records = [], skipped = [];
  const seen = new Set();

  for (const row of rows) {
    const name = col.name !== undefined
      ? at(row, col.name)
      : [at(row, col.first_name), at(row, col.last_name)].filter(Boolean).join(" ");
    const email = at(row, col.email);
    const rawRole = at(row, col.role);

    if (!name) { skipped.push({ line: row.line, value: email || "(blank)", reason: "No name" }); continue; }

    if (email && !EMAIL_RE.test(email)) {
      skipped.push({ line: row.line, value: name, reason: `"${email}" is not a valid email address` });
      continue;
    }

    let role = defaultRole;
    if (rawRole) {
      const resolved = canonicalRole(rawRole);
      if (resolved === undefined) {
        skipped.push({ line: row.line, value: name, reason: `Role "${rawRole}" is not one we recognise` });
        continue;
      }
      if (resolved) role = resolved;
    }

    // Email is the identity: it is what a login is created against, and what
    // requireAuth matches on. Two rows sharing one address would fight.
    const key = email ? email.toLowerCase() : `name:${name.toLowerCase()}`;
    if (seen.has(key)) {
      skipped.push({ line: row.line, value: name, reason: "Appears more than once in this file" });
      continue;
    }
    seen.add(key);

    records.push({ name, email: email || null, role });
  }

  return { records, skipped };
}

// --- Servers ----------------------------------------------------------------

const SERVER_ALIASES = {
  name: ["name", "full_name", "fullname", "server", "server_name", "employee", "employee_name", "staff_name"],
  first_name: ["first_name", "firstname", "first", "forename", "given_name"],
  last_name: ["last_name", "lastname", "last", "surname", "family_name"],
  phone: ["phone", "phone_number", "mobile", "cell", "cell_phone", "telephone", "contact_number"],
  email: ["email", "email_address", "e_mail", "work_email"],
};

// The name has to match what the POS writes against a sale, so it is stored
// as given and compared case- and whitespace-insensitively everywhere else.
function prepareServers({ headers, rows }) {
  const col = mapColumns(headers, SERVER_ALIASES);

  if (col.name === undefined && col.first_name === undefined) {
    return {
      error: `Could not find a name column. Found: ${headers.join(", ") || "(nothing)"}. Needs "name", or "first_name" and "last_name".`,
    };
  }

  const records = [], skipped = [];
  const seen = new Set();

  for (const row of rows) {
    const name = col.name !== undefined
      ? at(row, col.name)
      : [at(row, col.first_name), at(row, col.last_name)].filter(Boolean).join(" ");
    const phone = at(row, col.phone);
    const email = at(row, col.email);

    if (!name) { skipped.push({ line: row.line, value: "(blank)", reason: "No name" }); continue; }

    if (email && !EMAIL_RE.test(email)) {
      skipped.push({ line: row.line, value: name, reason: `"${email}" is not a valid email address` });
      continue;
    }

    // A number that is not E.164 will not send. Import the person anyway —
    // they still need to exist so their sales attribute — but drop the number
    // and say so, rather than storing something that silently never delivers.
    const normalisedPhone = normalisePhone(phone);
    const phoneWarning = phone && !normalisedPhone
      ? `Phone "${phone}" is not in +country format, so it was left blank`
      : null;

    const key = name.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) {
      skipped.push({ line: row.line, value: name, reason: "Appears more than once in this file" });
      continue;
    }
    seen.add(key);

    records.push({
      name,
      phone: normalisedPhone,
      email: email || null,
      reachable: Boolean(normalisedPhone || email),
      warning: phoneWarning,
    });
  }

  return { records, skipped };
}

// Accepts the ways a spreadsheet writes a US number and returns E.164, or
// null when it cannot be trusted.
function normalisePhone(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (E164_RE.test(value)) return value;

  const digits = value.replace(/[^\d]/g, "");
  if (value.startsWith("+")) {
    const candidate = `+${digits}`;
    return E164_RE.test(candidate) ? candidate : null;
  }
  if (digits.length === 10) return `+1${digits}`;                 // 610 555 1234
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

module.exports = {
  parseDelimited, mapColumns, prepareStaff, prepareServers,
  normalisePhone, canonicalRole, ROLES, ROLE_ALIASES,
};
