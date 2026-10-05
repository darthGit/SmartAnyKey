// updateNote is a service with an injected repo write (3-Tier, like services/health):
// persistence and the 2000 limit are tested without a live DB. The route's operator
// gate is a source scan.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NOTE_MAX, updateNote } from '../../server/services/notes'

const ROUTE = 'server/api/points/[pointId]/note.patch.ts'

describe('updateNote (AC-1, AC-7)', () => {
  it('persists_note: calls repo write with (pointId, note)', async () => {
    const write = vi.fn(async () => {})
    await updateNote({ write }, 'P1', 'роутер за шафою')
    expect(write).toHaveBeenCalledWith('P1', 'роутер за шафою')
  })

  it('rejects_over_2000: a note > NOTE_MAX throws, write is not called', async () => {
    const write = vi.fn(async () => {})
    await expect(updateNote({ write }, 'P1', 'x'.repeat(NOTE_MAX + 1))).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(NOTE_MAX).toBe(2000)
  })
})

describe('note route gate (AC-5)', () => {
  it('viewer_403_operator_ok: the route calls requireRole(..., "operator")', () => {
    const src = readFileSync(join(process.cwd(), ROUTE), 'utf8')
    expect(/requireRole\([\s\S]*?['"]operator['"]/.test(src)).toBe(true)
  })
})
