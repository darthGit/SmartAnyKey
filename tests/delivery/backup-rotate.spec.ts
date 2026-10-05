// After N+1 backups BACKUP_DIR holds exactly N files, the oldest one
// deleted. Without rotation a backup is a disk-fill timer.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { planRotation } from '../../scripts/backup.mjs'

// The name carries the time → lexicographic sort = chronological (no mtime).
const names = [
  'sak-20260901-030000.sql.gz',
  'sak-20260902-030000.sql.gz',
  'sak-20260903-030000.sql.gz',
  'sak-20260904-030000.sql.gz',
]

describe('backup rotation', () => {
  it('keeps_n_newest_deletes_oldest', () => {
    expect(planRotation(names, 3)).toEqual(['sak-20260901-030000.sql.gz'])
    expect(planRotation(names, 1)).toEqual(names.slice(0, 3))
  })

  it('deletes_nothing_below_the_limit', () => {
    expect(planRotation(names.slice(0, 2), 3)).toEqual([])
    expect(planRotation([], 3)).toEqual([])
  })

  it('ignores_unrelated_files', () => {
    // BACKUP_DIR may contain foreign files — rotation must not delete them.
    expect(planRotation([...names, 'notes.txt', 'sak-restore.log'], 1))
      .toEqual(names.slice(0, 3))
  })

  it('rejects_a_nonsense_keep_count', () => {
    // keep=0 would delete the backup just made — that is not "saving space", it is data loss.
    expect(() => planRotation(names, 0)).toThrow()
    expect(() => planRotation(names, -1)).toThrow()
  })
})
