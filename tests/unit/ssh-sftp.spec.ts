// RED. Pins the pure, breakable logic
// of the SFTP repo — dir-entry mapping, size cap, shell-quote (tar path), recursive
// remove via DI. The ssh2 glue (a real connection) is not mocked — connection-dependent
// criteria are verified on a live device, by observation. The test pattern is
// like guac-repo.spec (no vendor mock; here DI/pure functions).
import { describe, expect, it, vi } from 'vitest'
import {
  SFTP_READ_CAP,
  SftpTooLarge,
  assertReadable,
  isProbablyBinary,
  mapDirEntry,
  removeRecursive,
  shellSingleQuote,
} from '../../server/repositories/ssh'

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

describe('mapDirEntry (AC-1)', () => {
  it('maps mode/size/mtime → typed entry, type from format bits', () => {
    const dir = mapDirEntry({ filename: 'etc', attrs: { mode: S_IFDIR | 0o755, size: 4096, mtime: 1700000000 } })
    expect(dir).toEqual({ name: 'etc', type: 'dir', size: 4096, mtime: 1700000000, mode: 0o755 })

    const file = mapDirEntry({ filename: 'a.conf', attrs: { mode: S_IFREG | 0o644, size: 12, mtime: 1700000001 } })
    expect(file).toEqual({ name: 'a.conf', type: 'file', size: 12, mtime: 1700000001, mode: 0o644 })
  })
})

describe('assertReadable size-cap (AC-6)', () => {
  it('cap is 1 MiB', () => {
    expect(SFTP_READ_CAP).toBe(1024 * 1024)
  })
  it('throws SftpTooLarge over cap, passes at/under', () => {
    expect(() => assertReadable(SFTP_READ_CAP + 1)).toThrow(SftpTooLarge)
    expect(() => assertReadable(SFTP_READ_CAP)).not.toThrow()
    expect(() => assertReadable(0)).not.toThrow()
  })
})

describe('isProbablyBinary (AC-6 — viewing a binary → a warning)', () => {
  it('text (no NUL) → false; buffer with NUL byte → true', () => {
    expect(isProbablyBinary(Buffer.from('server { listen 80; }\n', 'utf8'))).toBe(false)
    expect(isProbablyBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(true) // ELF header
  })
  it('only inspects the first 8000 bytes', () => {
    const late = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00])]) // NUL at 8000
    expect(isProbablyBinary(late)).toBe(false)
  })
})

describe('shellSingleQuote tar-path (AC-7, input validation)', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellSingleQuote('/etc/nginx')).toBe('\'/etc/nginx\'')
    expect(shellSingleQuote('a\'b')).toBe('\'a\'\\\'\'b\'')
  })
  it('renders injection inert (stays inside one quoted literal)', () => {
    const q = shellSingleQuote('/tmp; rm -rf /')
    // Not a single unquoted `;` — everything is one literal.
    expect(q).toBe('\'/tmp; rm -rf /\'')
  })
})

describe('removeRecursive via DI (AC-5)', () => {
  it('removes children before parent (files unlinked, dirs rmdir bottom-up)', async () => {
    // Tree: /a (dir) → f1 (file), sub (dir) → f2 (file)
    const tree: Record<string, { name: string, type: 'file' | 'dir' }[]> = {
      '/a': [{ name: 'f1', type: 'file' }, { name: 'sub', type: 'dir' }],
      '/a/sub': [{ name: 'f2', type: 'file' }],
    }
    const calls: string[] = []
    const ops = {
      list: vi.fn(async (p: string) => tree[p] ?? []),
      unlink: vi.fn(async (p: string) => { calls.push(`unlink ${p}`) }),
      rmdir: vi.fn(async (p: string) => { calls.push(`rmdir ${p}`) }),
    }

    await removeRecursive('/a', 'dir', ops)

    // f2 and f1 are removed before rmdir of their dirs; sub before a (bottom-up).
    expect(calls).toEqual([
      'unlink /a/f1',
      'unlink /a/sub/f2',
      'rmdir /a/sub',
      'rmdir /a',
    ])
  })

  it('a plain file is unlinked, never rmdir', async () => {
    const ops = { list: vi.fn(), unlink: vi.fn(async () => {}), rmdir: vi.fn(async () => {}) }
    await removeRecursive('/a/x.txt', 'file', ops)
    expect(ops.unlink).toHaveBeenCalledWith('/a/x.txt')
    expect(ops.rmdir).not.toHaveBeenCalled()
    expect(ops.list).not.toHaveBeenCalled()
  })
})
