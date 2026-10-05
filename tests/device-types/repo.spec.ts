// RED (list, create, dup-slug→409, update). Data-access layer: maps PG codes to
// human statuses (not silent, not 500). Written before
// server/repositories/device-types.ts existed → failed. The sr mock — one chain
// per function (each function has exactly one PostgREST chain).
import { describe, expect, it } from 'vitest'
import { insertType, listTypes, updateType } from '../../server/repositories/device-types'

const TYPE = { id: 't1', slug: 'pos', name: 'POS', icon: 'i-lucide-monitor', color: '#f0f', default_action: 'vnc', sort: 0 }

describe('listTypes (AC-1)', () => {
  it('returns type rows', async () => {
    const sr = { from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [TYPE], error: null }) }) }) }
    expect(await listTypes(sr as never)).toEqual([TYPE])
  })
})

describe('insertType (AC-2 / AC-3)', () => {
  it('AC-2: inserts and returns the created type', async () => {
    let captured: unknown
    const sr = { from: () => ({ insert: (v: unknown) => { captured = v; return { select: () => ({ single: () => Promise.resolve({ data: { ...(v as object), id: 't9' }, error: null }) }) } } }) }
    const out = await insertType(sr as never, { slug: 'router', name: 'Router', icon: 'i', color: '#000', default_action: 'ssh', sort: 1 })
    expect(captured).toMatchObject({ slug: 'router' })
    expect(out).toMatchObject({ id: 't9', slug: 'router' })
  })

  it('AC-3: duplicate slug (PG 23505) → 409, not 500', async () => {
    const sr = { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } }) }) }) }) }
    await expect(insertType(sr as never, { slug: 'pos', name: 'x', icon: 'i', color: '#000', default_action: 'vnc' }))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('updateType (AC-5)', () => {
  it('saves the patch and returns the updated row', async () => {
    let captured: unknown
    const sr = { from: () => ({ update: (v: unknown) => { captured = v; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { ...TYPE, ...(v as object) }, error: null }) }) }) } } }) }
    const out = await updateType(sr as never, 't1', { name: 'POS-2', color: '#fff' })
    expect(captured).toMatchObject({ name: 'POS-2' })
    expect(out).toMatchObject({ name: 'POS-2', color: '#fff' })
  })
})
