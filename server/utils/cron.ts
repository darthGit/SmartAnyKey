// Minimal cron parser.
// No new dependency: 5 fields + `*`, `n`, `n-m`, `a,b`, `*/n` + `@hourly`/`@daily`
// — exactly what task scheduling needs.
//
// ponytail: TZ = the BFF process timezone (env `TZ` on the container), one per
// installation — per-task TZ is deliberately out of scope. Computed via local Date
// methods, so the runtime itself handles DST transitions.
//
// `nextRunAt` counts from the `from` passed in. The scheduler passes `now`
// (not the missed slot) — that is what prevents a burst after downtime.

export interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  /** dom/dow restricted (not `*`) → combined via OR, as in classic cron. */
  domRestricted: boolean
  dowRestricted: boolean
}

const SHORTHANDS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
}

const int = (raw: string, expr: string): number => {
  if (!/^\d+$/.test(raw))
    throw new Error(`cron: "${raw}" is not a number (expression "${expr}")`)
  return Number(raw)
}

function parseField(raw: string, min: number, max: number, expr: string): { set: Set<number>, restricted: boolean } {
  const set = new Set<number>()
  let restricted = true

  for (const part of raw.split(',')) {
    if (!part)
      throw new Error(`cron: empty element in "${raw}" (expression "${expr}")`)

    const [body, stepRaw] = part.split('/')
    if (part.split('/').length > 2)
      throw new Error(`cron: double step in "${part}" (expression "${expr}")`)

    let step = 1
    if (stepRaw !== undefined) {
      step = int(stepRaw, expr)
      if (step < 1)
        throw new Error(`cron: step 0 in "${part}" (expression "${expr}")`)
    }

    let lo: number
    let hi: number
    if (body === '*') {
      lo = min
      hi = max
      if (stepRaw === undefined)
        restricted = false
    }
    else if (body!.includes('-')) {
      const [a, b] = body!.split('-')
      lo = int(a!, expr)
      hi = int(b!, expr)
      if (hi < lo)
        throw new Error(`cron: reversed range "${body}" (expression "${expr}")`)
    }
    else {
      lo = hi = int(body!, expr)
    }

    if (lo < min || hi > max)
      throw new Error(`cron: "${part}" is outside ${min}-${max} (expression "${expr}")`)

    for (let v = lo; v <= hi; v += step) set.add(v)
  }

  if (!set.size)
    throw new Error(`cron: field "${raw}" matches nothing (expression "${expr}")`)
  return { set, restricted }
}

export function parseCron(expr: string): CronFields {
  const normalized = (SHORTHANDS[expr?.trim()] ?? expr ?? '').trim()
  if (!normalized)
    throw new Error('cron: empty expression')
  if (normalized.startsWith('@'))
    throw new Error(`cron: unknown shortcut "${expr}" (only @hourly/@daily)`)

  const fields = normalized.split(/\s+/)
  if (fields.length !== 5)
    throw new Error(`cron: expected 5 fields, got ${fields.length} ("${expr}")`)

  const [m, h, dom, mon, dow] = fields
  const minutes = parseField(m!, 0, 59, expr)
  const hours = parseField(h!, 0, 23, expr)
  const doms = parseField(dom!, 1, 31, expr)
  const months = parseField(mon!, 1, 12, expr)
  const dows = parseField(dow!, 0, 7, expr)

  // 7 == 0 (Sunday) — both notations are valid.
  if (dows.set.delete(7))
    dows.set.add(0)

  return {
    minutes: minutes.set,
    hours: hours.set,
    doms: doms.set,
    months: months.set,
    dows: dows.set,
    domRestricted: doms.restricted,
    dowRestricted: dows.restricted,
  }
}

/** Whether the calendar day fits (month + day-of-month/day-of-week). */
function dayMatches(f: CronFields, d: Date): boolean {
  if (!f.months.has(d.getMonth() + 1))
    return false
  const domOk = f.doms.has(d.getDate())
  const dowOk = f.dows.has(d.getDay())
  // Classic cron semantics: both restricted → OR; one is `*` → the other applies.
  if (f.domRestricted && f.dowRestricted)
    return domOk || dowOk
  if (f.domRestricted)
    return domOk
  if (f.dowRestricted)
    return dowOk
  return true
}

/** First fitting moment within this day, not earlier than `d`. */
function firstInDay(f: CronFields, d: Date): Date | null {
  for (let h = d.getHours(); h <= 23; h++) {
    if (!f.hours.has(h))
      continue
    const fromMinute = h === d.getHours() ? d.getMinutes() : 0
    for (let m = fromMinute; m <= 59; m++) {
      if (f.minutes.has(m))
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
    }
  }
  return null
}

/**
 * Next run strictly after `from`.
 * Iterates by days (not minutes): a non-matching day is skipped whole.
 */
export function nextRunAt(expr: string, from: Date): Date {
  const f = parseCron(expr)

  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // strictly in the future

  // Ceiling: 4 years of days. Reachable only for impossible combinations (e.g. 31
  // February) — then an error beats an infinite loop.
  for (let guard = 0; guard < 366 * 4; guard++) {
    if (dayMatches(f, d)) {
      const hit = firstInDay(f, d)
      if (hit)
        return hit
    }
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
  }

  throw new Error(`cron: "${expr}" has no run within 4 years — the expression is unreachable`)
}
