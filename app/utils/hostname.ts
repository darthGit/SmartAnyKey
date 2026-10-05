// Observed machine name vs the human label.
// A pure utility, because `PointHealthCard`/`admin/devices` are self-contained and the
// repo has no mock layer for them: the decision is tested here, the render by screenshot.

// Case and the trailing DNS dot are not a mismatch (`DESKTOP-4F8H2K` = `desktop-4f8h2k`,
// `kasa-7.` = `kasa-7`).
// ponytail: short name vs FQDN (`kasa-7` vs `kasa-7.lan`) are treated as different —
// stripping the domain would decide for the client how their machines are named.
const norm = (v?: string | null) => (v ?? '').trim().replace(/\.$/, '').toLowerCase()

// Marker for "the tree says one thing, the machine another". Empty observation ≠ mismatch.
export function hostnameMismatch(label?: string | null, hostname?: string | null): boolean {
  if (!hostname?.trim())
    return false
  return norm(label) !== norm(hostname)
}
