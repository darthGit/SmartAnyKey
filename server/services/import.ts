// Domain service: CSV bulk-import pipeline `parse → mapping → reconcile-by-key`.
// Pure functions, no DB (3-Tier: persistence in repositories/import.ts). The
// mapping is generic — no fixed client schema (pilot data validates the engine,
// it is not a default): the user maps their own headers onto domain fields;
// autoMatch only proposes a starting point by name.

export type Kind = 'points' | 'devices' | 'contacts'

export interface Parsed { headers: string[], rows: string[][] }
export type Mapping = Record<string, string>            // domain field → client header
export interface Mapped {
  rows: Record<string, string>[]
  errors: { line: number, reason: string }[]
}
export type DiffStatus = 'new' | 'update' | 'skip'
export interface DiffEntry {
  status: DiffStatus
  key: string
  row: Record<string, string>
  existingId?: string
}

// RFC-4180 minimum: quotes with a comma/newline inside = one field, "" = escaped quote.
export function parseCsv(text: string): Parsed {
  const s = text.replace(/\r\n?/g, '\n')
  const all: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else inQ = false
      }
      else { field += c }
      continue
    }
    if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); all.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); all.push(row) }
  const headers = all.shift() ?? []
  const rows = all.filter(r => r.some(cell => cell.trim() !== ''))
  return { headers, rows }
}

// Aliases for the initial auto-match. NOT a fixed schema — the user edits it afterwards.
const norm = (h: string) => h.toLowerCase().trim().replace(/[\s_.#№-]+/g, '')
const ALIASES: Record<Kind, Record<string, string[]>> = {
  points: {
    number: ['number', 'num', 'no', 'point', 'pointnumber', 'id', 'точка', 'номер'],
    address: ['address', 'addr', 'adres', 'адреса', 'адрес'],
    subnet: ['subnet', 'cidr', 'network', 'net', 'підмережа', 'мережа'],
  },
  devices: {
    host: ['host', 'ip', 'ipaddress', 'address', 'хост'],
    label: ['label', 'name', 'назва', 'description', 'опис'],
    type: ['type', 'kind', 'тип', 'devicetype'],
    point: ['point', 'pointnumber', 'точка', 'номерточки'],
  },
  // One CSV row = one contact. `kind` stays the client's own value
  // (phone/email/telegram/…) — we do not resolve it into any lookup of ours
  // (no domain defaults: client data stays the client's).
  contacts: {
    point: ['point', 'pointnumber', 'точка', 'номерточки'],
    kind: ['kind', 'type', 'вид', 'тип', 'канал'],
    value: ['value', 'contact', 'значення', 'контакт', 'phone', 'телефон', 'email', 'пошта'],
    label: ['label', 'name', 'назва', 'опис', 'підпис', 'посада', 'role', 'роль'],
  },
}

export function autoMatch(headers: string[], kind: Kind): Mapping {
  const out: Mapping = {}
  for (const [field, aliases] of Object.entries(ALIASES[kind])) {
    const set = new Set(aliases.map(norm))
    const hit = headers.find(h => set.has(norm(h)))
    if (hit) out[field] = hit
  }
  return out
}

// `points.address`/`points.subnet` are NOT NULL in 0001_schema.sql, so a row
// without them cannot be written. This used to be only ['number'] → such a CSV
// passed preview and failed with a raw 502 on apply. All validation is in
// preview (client data: preview and an honest result).
const REQUIRED: Record<Kind, string[]> = {
  points: ['number', 'address', 'subnet'],
  devices: ['host', 'type', 'point'],
  contacts: ['point', 'kind', 'value'],
}

// Applies the mapping to rows; malformed (a required field missing) → into errors
// with the line number (1-based, header = line 1), NOT silently dropped.
export function mapRows(parsed: Parsed, mapping: Mapping, kind: Kind): Mapped {
  const idx: Record<string, number> = {}
  for (const [field, header] of Object.entries(mapping)) {
    const col = parsed.headers.indexOf(header)
    if (col >= 0) idx[field] = col
  }
  const rows: Record<string, string>[] = []
  const errors: { line: number, reason: string }[] = []
  parsed.rows.forEach((cells, i) => {
    const line = i + 2
    const rec: Record<string, string> = {}
    for (const [field, col] of Object.entries(idx)) {
      const v = (cells[col] ?? '').trim()
      if (v !== '') rec[field] = v
    }
    const missing = REQUIRED[kind].filter(f => !rec[f])
    if (missing.length) { errors.push({ line, reason: `missing ${missing.join(', ')}` }); return }
    rows.push(rec)
  })
  return { rows, errors }
}

// Dry-run diff by key (propose-don't-write, ADR-012): points=number,
// devices=(point,host). Takes the existing rows as an argument — no DB access.
// new/update/skip; repeating an identical import → skip.
// contacts=(point,kind,value): the same triple = the same contact, so
// re-importing the same file gives skip, not a second row. Mirrors
// unique(point_id,kind,value_norm) in 0017.
const KEY_FIELDS: Record<Kind, string[]> = {
  points: ['number'],
  devices: ['point', 'host'],
  contacts: ['point', 'kind', 'value'],
}
const keyOf = (kind: Kind, r: Record<string, string>) => KEY_FIELDS[kind].map(f => r[f] ?? '').join('\u0000')

export function reconcileByKey(
  kind: Kind,
  mapped: Record<string, string>[],
  existing: Record<string, string>[],
): DiffEntry[] {
  const byKey = new Map(existing.map(e => [keyOf(kind, e), e]))
  return mapped.map((row) => {
    const key = keyOf(kind, row)
    const prev = byKey.get(key)
    if (!prev)
      return { status: 'new', key, row }
    const changed = Object.keys(row).some(f => (row[f] ?? '') !== (prev[f] ?? ''))
    return { status: changed ? 'update' : 'skip', key, row, existingId: prev.id }
  })
}

// Unique non-empty values of a mapped column — for the value-mapping UI:
// the client maps their own values (e.g. type='kassa') onto our entities.
export function distinctValues(parsed: Parsed, mapping: Mapping, field: string): string[] {
  const col = parsed.headers.indexOf(mapping[field] ?? '')
  if (col < 0) return []
  const set = new Set<string>()
  for (const cells of parsed.rows) {
    const v = (cells[col] ?? '').trim()
    if (v !== '') set.add(v)
  }
  return [...set]
}

// CSV template per kind: headers + a sample row. The client knows the format.
const TEMPLATE: Record<Kind, string> = {
  points: 'number,address,subnet\n147,"Main St 3",192.0.2.0/24',
  devices: 'host,label,type,point\n192.0.2.5,"POS 1",pos,147',
  // kind is the client's value; the code can make phone/email clickable,
  // anything else is shown as text and is imported too.
  contacts: 'point,kind,value,label\n147,phone,+380000000000,"manager"\n147,email,ops@example.com,',
}
export function csvTemplate(kind: Kind): string {
  return TEMPLATE[kind]
}

export interface BlockedRow { key: string, row: Record<string, string>, reason: string }
export interface ImportPlan {
  headers: string[]
  mapping: Mapping
  typeValues: string[]                          // distinct values of the type column (devices) — for value-mapping
  malformed: { line: number, reason: string }[] // structurally broken rows (a required field missing)
  blocked: BlockedRow[]                          // unresolved type/point — NOT imported
  diff: DiffEntry[]                              // valid rows only
  counts: { new: number, update: number, skip: number, blocked: number }
}

export interface BuildCtx {
  existing: Record<string, string>[]            // existing rows for reconcile (points|devices)
  valueMap?: Record<string, string>             // devices: type value from CSV → our device_type.id
  typeIds?: Set<string>                          // devices: valid type ids (validation)
  pointNumbers?: Set<string>                     // devices: existing point numbers (validation)
}

// Orchestrates parse→mapping→(value-resolve+validation)→reconcile. Pure (context
// from outside), so preview and confirm compute identically (confirm does not
// trust the client). No FK resolution by name: the type comes as valueMap;
// unresolved → blocked in preview, NOT a silent fail in apply.
export function buildImport(kind: Kind, csv: string, mapping: Mapping | undefined, ctx: BuildCtx): ImportPlan {
  const parsed = parseCsv(csv)
  const m = mapping && Object.keys(mapping).length ? mapping : autoMatch(parsed.headers, kind)
  const mapped = mapRows(parsed, m, kind)
  const typeValues = kind === 'devices' ? distinctValues(parsed, m, 'type') : []

  const blocked: BlockedRow[] = []
  const valid: Record<string, string>[] = []
  const key = (r: Record<string, string>) => KEY_FIELDS[kind].map(f => r[f] ?? '').join(' ')

  for (const row of mapped.rows) {
    if (kind === 'devices') {
      const typeId = ctx.valueMap?.[row.type ?? '']
      if (!typeId || (ctx.typeIds && !ctx.typeIds.has(typeId))) {
        blocked.push({ key: key(row), row, reason: `unmapped type "${row.type}"` })
        continue
      }
      if (ctx.pointNumbers && !ctx.pointNumbers.has(row.point ?? '')) {
        blocked.push({ key: key(row), row, reason: `unknown point ${row.point}` })
        continue
      }
      valid.push({ ...row, type_id: typeId }) // the row carries the resolved id — apply does not look up by name
    }
    else if (kind === 'contacts') {
      // A contact's only FK dependency is the point. Unresolved → blocked in
      // preview, not a silent fail in apply. `kind` is not validated: the list
      // of kinds belongs to the client.
      if (ctx.pointNumbers && !ctx.pointNumbers.has(row.point ?? '')) {
        blocked.push({ key: key(row), row, reason: `unknown point ${row.point}` })
        continue
      }
      valid.push(row)
    }
    else {
      valid.push(row)
    }
  }

  const diff = reconcileByKey(kind, valid, ctx.existing)
  const counts = {
    new: diff.filter(d => d.status === 'new').length,
    update: diff.filter(d => d.status === 'update').length,
    skip: diff.filter(d => d.status === 'skip').length,
    blocked: blocked.length,
  }
  return { headers: parsed.headers, mapping: m, typeValues, malformed: mapped.errors, blocked, diff, counts }
}
