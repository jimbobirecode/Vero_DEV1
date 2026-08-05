# POS modules

Everything the system knows about reading an end-of-shift report lives in
`server/lib/pos/`. One upload endpoint serves every POS: the club uploads the
export exactly as it comes out of their system, and the registry works out
which module should read it.

| Module | Vendor | File types | How it is recognised |
|---|---|---|---|
| `northstar` | NorthStar | PDF | The "Sales By Location" / "Daily Sales By Location" report title |
| `jonas` | Jonas Club Software (Club Management / Encore) | PDF, CSV, TSV, Excel | The Jonas name, report titles like "Member Charge Detail", "Revenue Centre" / "Chit #" vocabulary, or the account + department + amount column shape |
| `lightspeed` | Lightspeed Restaurant (K/L-Series) and Lightspeed Golf (Chronogolf) | PDF, CSV, TSV, Excel | The Lightspeed or Chronogolf name, the "Total excl./incl. tax" pair, or "Receipt number" alongside "Shop" |
| `generic` | anything else | PDF, CSV, TSV, Excel | Always scores 0.01, so it reads any export no vendor module claimed |

## How a file is read

`POST /api/visits/upload-pos` (multipart: `file`, optional `outlet_name`,
optional `vendor`) runs:

1. **Read** — `readDocument()` turns a PDF, CSV or spreadsheet into one shape:
   a grid of cells for CSV/Excel, text lines for PDF.
2. **Detect** — every module scores the document from 0 to 1 and the highest
   wins. A `vendor` in the request overrides detection entirely.
3. **Parse** — the module's column dictionary is matched against the header
   row, wherever it sits under the report's title block. NorthStar is the
   exception: its PDF wraps one check across several lines, so it keeps its own
   line-oriented parser in `server/lib/pos-parse.js`.
4. **Aggregate** — several checks by one member at one outlet on one day become
   a single visit, because survey eligibility is about what they spent there
   that day, not per check.
5. **Ingest** — `ingest.js` matches outlets and members and writes the visits.

The response carries a `parse_summary` describing exactly what happened:
which module read the file, which column it took as spend, which columns it
ignored, and how many rows it skipped. When a real export does not parse, that
summary is what tells you which matcher to add.

## Decisions worth knowing

**Spend is net of tax and gratuity.** Every module prefers a net / subtotal /
"excl. tax" column over the member's total charge. A club with an 18%
auto-gratuity and a $75 threshold would otherwise survey everybody who spent
$64, because the gratuity carried them over the line.

**A reversal nets out.** Voided and refunded checks arrive negative — as
`(9.00)` in Jonas, `-9.00` elsewhere — and are kept, so a member whose check was
taken back is not surveyed on a sale that no longer exists.

**Outlet matching is exact, then normalised, never fuzzy.** "GRILL ROOM",
"Grill Room" and "The Grill-Room" all resolve to the same outlet; anything
looser is refused, and two outlets that normalise alike are refused as well.
Mapping a check to the wrong outlet applies the wrong spend threshold, which
silently changes who gets surveyed.

**An unrecognised member is recorded but never queued.** An upload carries no
phone or email, so a member number the club does not have can never be
surveyed. Queueing it would put a permanently unsendable row in the queue.

**An ambiguous name is not matched.** Where a member is identified by name only
— routine on Lightspeed, where the customer record is optional at the till —
two members sharing that name means no match. Surveying the wrong one is worse
than not surveying.

## Adding a POS

A module is a dictionary and a detector. Copy `jonas.js`, then:

1. `detect(doc)` returns 0–1 from `doc.headText`. Score the vendor's name
   highest, then report titles and distinctive column wording, then the column
   shape for exports whose branding was stripped.
2. `columns` maps each field to matchers against the normalised header,
   strongest first. Fields: `member_id`, `member_name`, `outlet_name`,
   `spend_amount`, `check_total`, `visit_date`, `check_number`, `server_name`,
   `covers`. Only an amount and some way of identifying the member are
   required.
3. Optional hooks: `cleanMemberId`, `outletFromPreamble`, `dateFromPreamble`,
   `variant` (a label suffix), `prepare` (anything that needs the whole column
   before parsing — return settings, never store them on the profile, which is
   a module singleton shared by every in-flight upload), and `refineRow`.
4. Add it to `MODULES` in `index.js`, ahead of `generic`.
5. Add a fixture to `pos-modules.test.js`, including the vendor's awkward
   shapes: the title block above the header, names carrying commas, subtotal
   rows, a void, and whatever it does with dates.

Nothing in the route or the dashboard needs to change — the dropdown is built
from `GET /api/visits/pos-modules`.
