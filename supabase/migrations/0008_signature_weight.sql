-- 0008: rule engine = a COMBINATION of a type's signals (addendum 2026-07-15).
-- Before: one rule matched → type (single-signal OR) — port 22 tagged everything.
-- Now: a type = a set of signals, each with its OWN weight (strength); confidence% =
-- sum of matched weights / sum of all the type's weights (coverage); the user does not
-- split 100% between rules. So confidence(per-rule) → weight; sort is dead (priority via
-- coverage/weight) → drop it.
drop index if exists device_type_signatures_type;
alter table public.device_type_signatures rename column confidence to weight;
alter table public.device_type_signatures drop column if exists sort;
create index device_type_signatures_type on public.device_type_signatures (type_id);
