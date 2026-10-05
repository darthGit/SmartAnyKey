// Small fuzzy matcher for address search. No library.
// 0 = no match; higher = better. Substring > subsequence; an earlier match is better.
// ponytail: naive O(len·query) indexOf walk — enough for ~300 addresses in RAM;
//           if addresses reach thousands and this shows up in a profile — use fuse.js/mini.
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.trim().toLowerCase()
  if (!q)
    return 0
  const idx = t.indexOf(q)
  if (idx >= 0)
    return 1000 - Math.min(idx, 999) // substring: best, earlier = higher
  // subsequence (tolerates a small typo — missing letters):
  // all query characters in the same order in text, with gaps.
  let pos = 0
  let gaps = 0
  let first = -1
  for (const ch of q) {
    const f = t.indexOf(ch, pos)
    if (f < 0)
      return 0
    if (first < 0)
      first = f
    if (pos > 0)
      gaps += f - pos
    pos = f + 1
  }
  return Math.max(1, 500 - gaps - first) // below any substring
}
