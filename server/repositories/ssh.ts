// Repository: the only layer that imports ssh2 (3-tier — external SDKs
// only here). Opens an SSH connection + shell stream, returns low-level
// handles; all error classification / orchestration lives in services/ssh-bridge.
import { posix } from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import type { Readable, Writable } from 'node:stream'

export interface ShellHandle {
  stream: ClientChannel
  conn: Client
}

export function openShell(opts: {
  host: string
  port: number
  username: string
  password: string
  cols: number
  rows: number
}): Promise<ShellHandle> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      conn.shell({ cols: opts.cols, rows: opts.rows, term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          conn.end()
          reject(err)
          return
        }
        resolve({ stream, conn })
      })
    })
    conn.on('error', reject)
    conn.connect({ host: opts.host, port: opts.port, username: opts.username, password: opts.password })
  })
}

// One-shot exec: runs a command/script via conn.exec,
// collects stdout/stderr/exit-code. Timeout kills the connection (reason 'timedOut').
// Error classification is in services/command-runner (same split as openShell).
export function execCommand(opts: {
  host: string
  port: number
  username: string
  password: string
  command: string
  timeoutMs: number
}): Promise<{ stdout: string, stderr: string, code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let settled = false
    const timer = setTimeout(
      () => finish(() => reject(Object.assign(new Error('exec timed out'), { timedOut: true }))),
      opts.timeoutMs,
    )
    function finish(fn: () => void) {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      conn.end()
      fn()
    }
    conn.on('ready', () => {
      conn.exec(opts.command, (err, stream) => {
        if (err) {
          finish(() => reject(err))
          return
        }
        let stdout = ''
        let stderr = ''
        stream.on('close', (code: number) => finish(() => resolve({ stdout, stderr, code: code ?? 0 })))
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      })
    })
    conn.on('error', err => finish(() => reject(err)))
    conn.connect({ host: opts.host, port: opts.port, username: opts.username, password: opts.password })
  })
}

// ── SFTP ─────────────────────────────────────────────────────────────────────
// The same repo layer (the only one with ssh2, 3-tier). Pure functions below are
// unit-tested (ssh-sftp.spec); the ssh2 glue is verified on a live device.
// ponytail: conn per request (open→op→close); a per-device pool if latency
// becomes a pain.

export interface SshConnOpts {
  host: string
  port: number
  username: string
  password: string
}

export interface SftpEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  mode: number // perm bits (0o777), without format bits
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

// ssh2 readdir entry (FileEntry) → normalized SftpEntry. Type from the format bits.
export function mapDirEntry(e: { filename: string, attrs: { mode: number, size: number, mtime: number } }): SftpEntry {
  const mode = e.attrs.mode
  return {
    name: e.filename,
    type: (mode & S_IFMT) === S_IFDIR ? 'dir' : 'file',
    size: e.attrs.size,
    mtime: e.attrs.mtime,
    mode: mode & 0o777,
  }
}

export const SFTP_READ_CAP = 1024 * 1024 // 1 MiB — inline-edit read ceiling
export class SftpTooLarge extends Error {}
export class SftpBinary extends Error {}

export function assertReadable(size: number): void {
  if (size > SFTP_READ_CAP)
    throw new SftpTooLarge(`File too large for editor (${size} > ${SFTP_READ_CAP} bytes)`)
}

// Binary? Git heuristic: a NUL byte in the first 8000 bytes = not text. Cheap and
// reliable for configs/logs; UTF-16 text (rare on *nix) is a false positive
// — ponytail: switch to charset detection if needed.
export function isProbablyBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

// POSIX single-quote escape: close the quote, escape ', reopen.
// Makes an arbitrary path inert in a shell command (tar) — input validation.
export function shellSingleQuote(s: string): string {
  return `'${s.split('\'').join('\'\\\'\'')}'`
}

export interface RemoveOps {
  list: (path: string) => Promise<{ name: string, type: 'file' | 'dir' }[]>
  unlink: (path: string) => Promise<void>
  rmdir: (path: string) => Promise<void>
}

// Recursive removal (DI — to test without ssh2). Children before the parent.
export async function removeRecursive(path: string, type: 'file' | 'dir', ops: RemoveOps): Promise<void> {
  if (type === 'file') {
    await ops.unlink(path)
    return
  }
  for (const e of await ops.list(path))
    await removeRecursive(posix.join(path, e.name), e.type, ops)
  await ops.rmdir(path)
}

function connect(opts: SshConnOpts): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => resolve(conn))
    conn.on('error', reject)
    conn.connect({ host: opts.host, port: opts.port, username: opts.username, password: opts.password })
  })
}

function getSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
}

// open→sftp→fn→close. Atomic operations (list/mkdir/rename/remove/read/write-text).
export async function withSftp<T>(opts: SshConnOpts, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const conn = await connect(opts)
  try {
    return await fn(await getSftp(conn))
  }
  finally {
    conn.end()
  }
}

export function sftpList(opts: SshConnOpts, path: string): Promise<SftpEntry[]> {
  return withSftp(opts, sftp => new Promise((res, rej) =>
    sftp.readdir(path, (err, list) => (err ? rej(err) : res(list.map(mapDirEntry))))))
}

export function sftpMkdir(opts: SshConnOpts, path: string): Promise<void> {
  return withSftp(opts, sftp => new Promise((res, rej) => sftp.mkdir(path, err => (err ? rej(err) : res()))))
}

export function sftpRename(opts: SshConnOpts, from: string, to: string): Promise<void> {
  return withSftp(opts, sftp => new Promise((res, rej) => sftp.rename(from, to, err => (err ? rej(err) : res()))))
}

// chmod: mode — perm bits (0o000..0o777). chown/chgrp deliberately out of scope
// (root-dependent, need uid/gid resolution).
export function sftpChmod(opts: SshConnOpts, path: string, mode: number): Promise<void> {
  return withSftp(opts, sftp => new Promise((res, rej) => sftp.chmod(path, mode, err => (err ? rej(err) : res()))))
}

function entryType(sftp: SFTPWrapper, path: string): Promise<'file' | 'dir'> {
  return new Promise((res, rej) => sftp.lstat(path, (err, st) => (err ? rej(err) : res(st.isDirectory() ? 'dir' : 'file'))))
}

// Remove a file or a directory (recursively). Type is determined by lstat.
export function sftpRemove(opts: SshConnOpts, path: string): Promise<void> {
  return withSftp(opts, async (sftp) => {
    const type = await entryType(sftp, path)
    await removeRecursive(path, type, {
      list: p => new Promise((res, rej) => sftp.readdir(p, (err, l) => (err ? rej(err) : res(l.map(mapDirEntry))))),
      unlink: p => new Promise((res, rej) => sftp.unlink(p, err => (err ? rej(err) : res()))),
      rmdir: p => new Promise((res, rej) => sftp.rmdir(p, err => (err ? rej(err) : res()))),
    })
  })
}

// Inline-edit read: size cap before reading (we do not pull megabytes into the editor).
export function sftpReadText(opts: SshConnOpts, path: string): Promise<string> {
  return withSftp(opts, async (sftp) => {
    const size = await new Promise<number>((res, rej) => sftp.stat(path, (err, st) => (err ? rej(err) : res(st.size))))
    assertReadable(size)
    return new Promise((res, rej) => {
      const chunks: Buffer[] = []
      const s = sftp.createReadStream(path)
      s.on('data', (c: Buffer) => chunks.push(c))
      s.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (isProbablyBinary(buf))
          rej(new SftpBinary(`Binary file not viewable: ${path}`))
        else
          res(buf.toString('utf8'))
      })
      s.on('error', rej)
    })
  })
}

export function sftpWriteText(opts: SshConnOpts, path: string, content: string): Promise<void> {
  return withSftp(opts, sftp => new Promise((res, rej) => {
    const w = sftp.createWriteStream(path)
    w.on('close', () => res())
    w.on('error', rej)
    w.end(content)
  }))
}

// Stream helpers: conn lives until the stream closes (download/upload of large
// files without buffering). The controller pipes to/from the response.
export async function sftpReadStream(opts: SshConnOpts, path: string): Promise<Readable> {
  const conn = await connect(opts)
  const sftp = await getSftp(conn)
  const stream = sftp.createReadStream(path)
  const done = (): void => { conn.end() }
  stream.on('close', done)
  stream.on('error', done)
  return stream
}

export async function sftpWriteStream(opts: SshConnOpts, path: string): Promise<Writable> {
  const conn = await connect(opts)
  const sftp = await getSftp(conn)
  const stream = sftp.createWriteStream(path)
  const done = (): void => { conn.end() }
  stream.on('close', done)
  stream.on('error', done)
  return stream
}

// Directory download = remote tar (the host archives itself, zero archiver deps). The path
// is escaped (shellSingleQuote) — the actor already has a shell with those credentials (not an escalation).
export async function sftpTarStream(opts: SshConnOpts, path: string): Promise<Readable> {
  const conn = await connect(opts)
  const cmd = `tar -C ${shellSingleQuote(posix.dirname(path))} -czf - ${shellSingleQuote(posix.basename(path))}`
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        conn.end()
        reject(err)
        return
      }
      const done = (): void => { conn.end() }
      stream.on('close', done)
      stream.on('error', done)
      resolve(stream)
    })
  })
}
