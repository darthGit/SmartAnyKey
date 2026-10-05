// Behaviour of the image entrypoint.
//
// The test runs the script, it does not scan it: what it catches is a regression
// I already made once in this same pass. By setting ENTRYPOINT I also overrode
// every ops command that goes through the same image (ADR-020:
// `compose run --rm app node scripts/*.mjs`), including `bootstrap.mjs`, which
// runs before `.env` exists — so the first install step would fail on
// resolving an address nobody is there to set yet.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SH = 'scripts/app-entrypoint.sh'

function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync('sh', [SH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function runFail(args: string[], env: Record<string, string> = {}) {
  try {
    execFileSync('sh', [SH, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' })
    return null
  }
  catch (e) {
    const err = e as { status: number, stderr: string }
    return { status: err.status, stderr: err.stderr }
  }
}

describe('app entrypoint (AC-5)', () => {
  it('passes_ops_commands_through_untouched', () => {
    // Had the address gate been here too, this call would either fail or rewrite env.
    expect(run(['echo', 'bootstrap-would-run-here'])).toContain('bootstrap-would-run-here')
  })

  it('does_not_resolve_address_for_ops_commands', () => {
    const out = run(['sh', '-c', 'echo "url=${NUXT_PUBLIC_SUPABASE_URL:-unset}"'])
    expect(out).toContain('url=unset')
  })

  it('keeps_an_explicit_address_for_ops_commands', () => {
    const out = run(
      ['sh', '-c', 'echo "url=${NUXT_PUBLIC_SUPABASE_URL:-unset}"'],
      { NUXT_PUBLIC_SUPABASE_URL: 'http://192.0.2.10:8000' },
    )
    expect(out).toContain('url=http://192.0.2.10:8000')
  })
})

// Found by a live run on 2026-09-18: address auto-detection was asked for in the
// entrypoint itself, and it worked — picking `172.19.0.14`, the container's own
// address on the compose network. Host interfaces are not visible from a container
// by construction, so the resolver moved to the host (`docker/install.sh`) and a
// guard stayed here. These two tests hold the guard.
describe('entrypoint refuses an unusable address', () => {
  // A path that never exists but still matches the gate's `*.output/server/index.mjs`:
  // with a real build in `.output` the pass-through case starts the server and hangs.
  const SERVER = ['node', 'missing/.output/server/index.mjs']

  it('refuses_to_start_without_an_address', () => {
    const r = runFail(SERVER, { NUXT_PUBLIC_SUPABASE_URL: '' })
    expect(r, 'an empty address must stop startup').not.toBeNull()
    expect(r!.stderr).toContain('is empty')
  })

  it('lets_a_normal_address_through', () => {
    // The hole the bug slipped through: I only checked that bad addresses fail,
    // never that a normal one passes. `[::1]` in an unquoted `case` is the glob
    // class {:, 1}, so every address with a port matched as loopback
    // (caught by a live run on `http://172.17.0.2:8000`, not by a test).
    const r = runFail(SERVER, { NUXT_PUBLIC_SUPABASE_URL: 'http://192.0.2.10:8000' })
    // It then fails on the missing server file — but NOT at the gate.
    expect(r?.stderr ?? '', 'a normal address must not read as loopback')
      .not.toContain('loopback')
  })

  it('still_refuses_real_ipv6_loopback', () => {
    const r = runFail(SERVER, { NUXT_PUBLIC_SUPABASE_URL: 'http://[::1]:8000' })
    expect(r, 'IPv6 loopback must be rejected').not.toBeNull()
    expect(r!.stderr).toContain('loopback')
  })

  it('refuses_loopback_because_it_500s_every_gated_route', () => {
    for (const bad of ['http://localhost:8000', 'http://127.0.0.1:8000']) {
      const r = runFail(SERVER, { NUXT_PUBLIC_SUPABASE_URL: bad })
      expect(r, `${bad} must be rejected`).not.toBeNull()
      expect(r!.stderr).toContain('loopback')
    }
  })
})
