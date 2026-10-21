// Release check: is a newer release out, and does the check stay quiet when it should.
import { describe, expect, it, vi } from 'vitest'
import { checkLatest, isNewer, updateState } from '../../server/services/update-check'

// Fields of the real `GET /repos/darthGit/SmartAnyKey/releases/latest` answer, 2026-10-21.
const RELEASE = {
  tag_name: 'v0.1.0',
  html_url: 'https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.0',
  draft: false,
  prerelease: false,
}
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

describe('isNewer', () => {
  it('compares vX.Y.Z numerically', () => {
    expect(isNewer('v0.1.0', 'v0.1.1')).toBe(true)
    expect(isNewer('v0.9.0', 'v0.10.0')).toBe(true)
    expect(isNewer('v0.1.1', 'v0.1.0')).toBe(false)
    expect(isNewer('v0.1.0', 'v0.1.0')).toBe(false)
  })

  it('dev, unknown or a non-release tag is never outdated', () => {
    expect(isNewer('dev', 'v9.9.9')).toBe(false)
    expect(isNewer('unknown', 'v9.9.9')).toBe(false)
    expect(isNewer('v0.1.0-3-gabc123', 'v9.9.9')).toBe(false)
    expect(isNewer('v0.1.0', 'nightly')).toBe(false)
  })
})

describe('checkLatest', () => {
  it('stores the latest tag and its page', async () => {
    await checkLatest('darthGit/SmartAnyKey', ok(RELEASE))
    expect(updateState()).toMatchObject({ latest: 'v0.1.0', url: RELEASE.html_url })
  })

  it('an empty repo means no request at all', async () => {
    const f = ok(RELEASE)
    await checkLatest('', f)
    expect(f).not.toHaveBeenCalled()
  })

  it('a network failure keeps the last state and warns once', async () => {
    await checkLatest('darthGit/SmartAnyKey', ok(RELEASE))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await checkLatest('darthGit/SmartAnyKey', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }))
    expect(updateState()).toMatchObject({ latest: 'v0.1.0' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('an HTTP error (rate limit) does not throw and keeps the state', async () => {
    await expect(checkLatest('darthGit/SmartAnyKey', vi.fn(async () => new Response('{}', { status: 403 })))).resolves.toBeUndefined()
    expect(updateState()).toMatchObject({ latest: 'v0.1.0' })
  })
})
