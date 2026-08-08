-- Give a person a type, the same way a visit has one.
--
-- Visits have carried visitor_type since the start — member, visitor,
-- commercial, other, golf — but the People list could only hold members. A
-- regular guest or a corporate contact had to be retyped into every visit
-- rather than existing as a record, and the two screens offered different
-- vocabularies for the same idea.
--
-- The values here are exactly the ones visits.visitor_type allows, and both
-- constraints are now generated from the same list in lib/person-types.js.
--
-- Safe to run more than once.

alter table members add column if not exists member_type text not null default 'member';

-- The same five values as visits.visitor_type. 'golf' is accepted for parity —
-- a golf-only contact is a coherent thing for a club to hold — even though the
-- forms do not offer it, because golf visits are created by the tee sheet
-- importer rather than typed in.
alter table members drop constraint if exists members_member_type_check;
alter table members add  constraint members_member_type_check
  check (member_type in ('member','visitor','commercial','other','golf'));

-- The People list filters by type, the same way the Visits list does.
create index if not exists members_member_type_idx on members (member_type);

-- Existing rows are members: that is what the table held before this column
-- existed, and defaulting them to anything else would silently reclassify a
-- club's entire roster.
update members set member_type = 'member' where member_type is null;

-- Bring visits into line with the shared list, in case this database predates
-- the migration note in schema.sql that added 'golf'.
alter table visits drop constraint if exists visits_visitor_type_check;
alter table visits add  constraint visits_visitor_type_check
  check (visitor_type in ('member','visitor','commercial','other','golf'));
