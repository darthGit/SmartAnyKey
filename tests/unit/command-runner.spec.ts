// The command-runner core. `wrap` is a pure function (base64 pipe per
// interpreter); `runCommand` orchestrates resolve→wrap→exec→classify, without
// writing to the DB (persisting = the controller). The ssh repo (execCommand) and
// resolveCredentials are mocked (three-tier layering, like
// tests/terminal/ssh-bridge.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnv, maskSecrets, runCommand, runLocal, wrap } from '../../server/services/command-runner'

const { execCommand } = vi.hoisted(() => ({ execCommand: vi.fn() }))
const { resolveCredentials, resolveSetById } = vi.hoisted(() => ({ resolveCredentials: vi.fn(), resolveSetById: vi.fn() }))
vi.mock('../../server/repositories/ssh', () => ({ execCommand }))
vi.mock('../../server/services/credentials', () => ({ resolveCredentials, resolveSetById }))

const b64of = (wrapped: string) => wrapped.match(/'([^']+)'/)![1]
const sshDevice = { id: 'dev-1', host: '10.0.0.5', actions: ['ssh'] }
const cmd = { id: 'c1', label: 'status', body: 'echo hi', interpreter: 'raw', timeout_s: 45 }
const client = {} as never

beforeEach(() => {
  execCommand.mockReset()
  resolveCredentials.mockReset()
  resolveCredentials.mockResolvedValue({ username: 'u', password: 'p', port: 22 })
})

describe('wrap (AC-4/5)', () => {
  it('AC-4: raw sends the body as is', () => {
    expect(wrap('raw', 'ip a')).toBe('ip a')
  })

  it('AC-4: python pipes the body into python3', () => {
    const w = wrap('python', 'print(1)')
    expect(w).toContain('python3')
    expect(Buffer.from(b64of(w), 'base64').toString()).toBe('print(1)')
  })

  it('AC-4: node pipes into node, bash into bash', () => {
    expect(wrap('node', 'console.log(1)')).toContain('node')
    expect(wrap('bash', 'echo x')).toContain('bash')
  })

  it('AC-5: special characters (quotes/$/newlines) survive verbatim via base64', () => {
    const body = `echo "a'b" $HOME\nprintf '%s' 'x'`
    const decoded = Buffer.from(b64of(wrap('bash', body)), 'base64').toString()
    expect(decoded).toBe(body)
  })
})

describe('runCommand (AC-6/7)', () => {
  it('AC-6: device without an ssh action → failed reason=action, exec is not called', async () => {
    const res = await runCommand(client, { device: { ...sshDevice, actions: ['vnc'] }, command: cmd, actor: 'a', keyHex: 'k' })
    expect(res.status).toBe('failed')
    expect(res.error).toBe('action')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('AC-6: no resolved credential → failed reason=auth', async () => {
    resolveCredentials.mockResolvedValue(null)
    const res = await runCommand(client, { device: sshDevice, command: cmd, actor: 'a', keyHex: 'k' })
    expect(res.status).toBe('failed')
    expect(res.error).toBe('auth')
  })

  it('AC-7: exceeding timeout_s → failed reason=timeout', async () => {
    execCommand.mockRejectedValue(Object.assign(new Error('exec timed out'), { timedOut: true }))
    const res = await runCommand(client, { device: sshDevice, command: { ...cmd, timeout_s: 1 }, actor: 'a', keyHex: 'k' })
    expect(res.status).toBe('failed')
    expect(res.error).toBe('timeout')
  })

  it('successful exit=0 → done', async () => {
    execCommand.mockResolvedValue({ stdout: 'hi\n', stderr: '', code: 0 })
    const res = await runCommand(client, { device: sshDevice, command: cmd, actor: 'a', keyHex: 'k' })
    expect(res.status).toBe('done')
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('hi\n')
  })

  it('exit≠0 stays done (exit code = result, not an infra failure)', async () => {
    execCommand.mockResolvedValue({ stdout: '', stderr: 'boom\n', code: 3 })
    const res = await runCommand(client, { device: sshDevice, command: cmd, actor: 'a', keyHex: 'k' })
    expect(res.status).toBe('done')
    expect(res.exitCode).toBe(3)
  })

  it('bash + formValues/meta/creds → export into the command, password masked in output', async () => {
    resolveSetById.mockResolvedValue({ username: 'svc', password: 'sekret', port: null })
    execCommand.mockResolvedValue({ stdout: 'key=sekret dir=etc\n', stderr: '', code: 0 })
    const res = await runCommand(client, {
      device: { ...sshDevice, meta: { SERIAL: 'SN-9' } },
      command: { id: 'c2', label: 'ls', body: 'ls "$FOLDER"', interpreter: 'bash', timeout_s: 30, credRefs: [{ set_id: 's1', env: 'API' }] },
      actor: 'a', keyHex: 'k', formValues: { FOLDER: 'etc' },
    })
    const sent = execCommand.mock.calls[0]![0].command as string
    expect(sent).toContain('export FOLDER=\'etc\'') // param → env
    expect(sent).toContain('export SERIAL=\'SN-9\'') // meta → env
    expect(sent).toContain('export API_PASSWORD=\'sekret\'') // cred prefix
    expect(res.stdout).not.toContain('sekret') // password masked
    expect(res.stdout).toContain('[REDACTED]')
  })

  it('raw stays verbatim — no export even with formValues (RouterOS-safe)', async () => {
    execCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    await runCommand(client, { device: { ...sshDevice, meta: { X: '1' } }, command: cmd, actor: 'a', keyHex: 'k', formValues: { A: 'b' } })
    expect(execCommand.mock.calls[0]![0].command).toBe('echo hi') // wrap('raw',...) = body as-is, no export
  })
})

// --- Phase 2: local executor ---------------------------------------------------
// buildEnv is pure; maskSecrets is pure; runLocal is a fetch to the executor service
// (URL+secret are passed in opts.executor, like keyHex — the controller reads config).
describe('buildEnv (AC-2)', () => {
  it('AC-2: device.meta keys go into env verbatim; device columns under DEVICE_*', () => {
    const env = buildEnv({
      device: { id: 'dev-1', host: '10.0.0.5', meta: { SERIAL: 'SN-42', internal_id: 7 } },
      secrets: {},
      formValues: {},
    })
    expect(env.SERIAL).toBe('SN-42')
    expect(env.internal_id).toBe('7') // values are stringified
    expect(env.DEVICE_HOST).toBe('10.0.0.5')
    expect(env.DEVICE_ID).toBe('dev-1')
  })

  it('AC-2: different meta → different value (per-device)', () => {
    const a = buildEnv({ device: { id: 'a', host: 'h', meta: { SERIAL: 'AAA' } }, secrets: {}, formValues: {} })
    const b = buildEnv({ device: { id: 'b', host: 'h', meta: { SERIAL: 'BBB' } }, secrets: {}, formValues: {} })
    expect(a.SERIAL).toBe('AAA')
    expect(b.SERIAL).toBe('BBB')
  })

  it('form values and secrets merge over meta', () => {
    const env = buildEnv({
      device: { id: 'd', host: 'h', meta: { K: 'from-meta' } },
      secrets: { APIKEY: 'sekret' },
      formValues: { K: 'from-form' },
    })
    expect(env.K).toBe('from-form')
    expect(env.APIKEY).toBe('sekret')
  })
})

describe('maskSecrets (AC-12)', () => {
  it('AC-12: a verbatim occurrence of a secret → [REDACTED]', () => {
    expect(maskSecrets('token=abc123 done', ['abc123'])).toBe('token=[REDACTED] done')
  })

  it('AC-12: masks several secrets, ignores empty ones', () => {
    expect(maskSecrets('a=X b=Y', ['X', 'Y', ''])).toBe('a=[REDACTED] b=[REDACTED]')
  })
})

describe('runLocal (AC-1/5/7/8/12)', () => {
  const fetchMock = vi.fn()
  const localCmd = {
    id: 'lc1', label: 'cash-status', body: 'echo "$CRED_USER:$CRED_PASSWORD"', interpreter: 'bash',
    timeout_s: 30, target: 'local' as const, credRefs: [{ set_id: 'set-1', env: 'CRED' }],
  }
  const localOpts = () => ({
    device: { id: 'dev-1', host: '10.0.0.5', actions: [] as string[], meta: { SERIAL: 'SN-1' } },
    command: localCmd,
    actor: 'a',
    keyHex: 'k',
    executor: { url: 'http://executor:8080/run', secret: 's3cret' },
  })

  beforeEach(() => {
    fetchMock.mockReset()
    resolveSetById.mockReset()
    resolveSetById.mockResolvedValue({ username: 'api', password: 'super-secret-key', port: 8443 })
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ stdout: 'ok\n', stderr: '', exit: 0 }) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('AC-1/5: sends interpreter/body/env to the executor, does NOT touch ssh execCommand', async () => {
    const res = await runLocal(client, localOpts())
    expect(execCommand).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://executor:8080/run')
    const payload = JSON.parse(init.body)
    expect(payload.interpreter).toBe('bash')
    // A set expands into PREFIX_USER / PREFIX_PASSWORD / PREFIX_PORT (login+password).
    expect(payload.env.CRED_USER).toBe('api')
    expect(payload.env.CRED_PASSWORD).toBe('super-secret-key')
    expect(payload.env.CRED_PORT).toBe('8443')
    expect(payload.env.SERIAL).toBe('SN-1') // meta injection
    expect(res.status).toBe('done')
    expect(res.exitCode).toBe(0)
  })

  it('AC-12: an injected secret in stdout is masked before returning', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ stdout: 'key=super-secret-key\n', stderr: '', exit: 0 }) })
    const res = await runLocal(client, localOpts())
    expect(res.stdout).not.toContain('super-secret-key')
    expect(res.stdout).toContain('[REDACTED]')
  })

  it('AC-7: executor unreachable (fetch reject) → failed reason=executor, no throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await runLocal(client, localOpts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('executor')
  })

  it('AC-8: executor signals timeout → failed reason=timeout', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ stdout: '', stderr: '', exit: null, timedOut: true }) })
    const res = await runLocal(client, localOpts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('timeout')
  })
})
