// Bulk naming in the discovery drawer: `Till {n}` → Till 1…N over the selected hosts in
// selection order. Hand-edited names stay and do not take a number. Without `{n}` several
// hosts still get distinct names (a suffix), one host gets the template as is.
export function fillNames(template: string, selected: string[], names: Record<string, string>, edited: Set<string>): Record<string, string> {
  const free = selected.filter(id => !edited.has(id))
  const tpl = template.includes('{n}') || free.length < 2 ? template : `${template} {n}`
  const out = { ...names }
  free.forEach((id, i) => { out[id] = tpl.replaceAll('{n}', String(i + 1)) })
  return out
}
