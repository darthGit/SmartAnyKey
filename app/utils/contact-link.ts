// Contact render scheme.
// Pure function — same pattern as `device-icon.ts::resolveDeviceIcon`:
// the presentation decision lives in utils, not in the template.
//
// The code knows a scheme only for kinds the platform actually has one for.
// The list of contact kinds is client data (`kind` is free text), so anything
// unfamiliar (telegram, viber, radio) is shown as text and works without a migration.
// Kinds the platform has a link scheme for — and only these are ranked.
// Phone first: during a call it is needed first.
export const LINKED_KINDS = ['phone', 'email']

interface SortableContact { kind: string, value: string, sort: number }

// Contact display order. Without it the list comes as the DB returned it: imported
// rows have sort=0 and interleave with seeded ones by `id`
// (PHONE/EMAIL/PHONE/PHONE/EMAIL/…) — looks "inconsistent".
// Client-defined kinds are not ranked (no domain defaults) — sorted alphabetically at the end.
export function sortContacts<T extends SortableContact>(rows: T[]): T[] {
  const rank = (k: string) => {
    const i = LINKED_KINDS.indexOf(k)
    return i === -1 ? LINKED_KINDS.length : i
  }
  return [...rows].sort((a, b) =>
    rank(a.kind) - rank(b.kind)
    || a.kind.localeCompare(b.kind)
    || a.sort - b.sort
    || a.value.localeCompare(b.value, undefined, { numeric: true }))
}

export function contactHref(kind: string, value: string): string | null {
  const v = value.trim()
  if (!v)
    return null
  if (kind === 'phone') {
    // tel: must be dialable: strip spaces/brackets/dashes, keep '+'.
    const dialable = v.replace(/[^\d+]/g, '')
    return dialable ? `tel:${dialable}` : null
  }
  if (kind === 'email')
    return `mailto:${v}`
  return null
}
