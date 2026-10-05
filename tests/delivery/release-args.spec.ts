// Checks the `scripts/release.mjs` parser — branchy logic, so it leaves one
// runnable check behind. It does NOT prove the release itself: that is a live run
// (both images built/pushed).
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { parseArgs, tagsFor } from '../../scripts/release.mjs'

describe('release argv', () => {
  it('tag is the first non-flag, push is the default', () => {
    expect(parseArgs(['v1.2.3'])).toEqual({ tag: 'v1.2.3', push: true, multiArch: false })
    expect(parseArgs([])).toEqual({ tag: undefined, push: true, multiArch: false })
  })

  it('flag order does not matter', () => {
    expect(parseArgs(['--multi-arch', 'v1'])).toEqual({ tag: 'v1', push: true, multiArch: true })
    expect(parseArgs(['v1', '--no-push'])).toEqual({ tag: 'v1', push: false, multiArch: false })
  })

  it('rejects the combination that cannot work', () => {
    // a multi-platform image does not materialize locally — only in a registry.
    expect(() => parseArgs(['v1', '--multi-arch', '--no-push'])).toThrow(/multi-arch/)
  })

  it('rejects typos instead of ignoring them', () => {
    expect(() => parseArgs(['--multiarch'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['v1', 'v2'])).toThrow(/one tag/)
  })
})

// README and install.sh default to `latest`, so a stable release must move it —
// otherwise the documented one-command install pulls a tag that does not exist.
describe('release tags', () => {
  it('a stable version also moves latest', () => {
    expect(tagsFor('v0.1.0')).toEqual(['v0.1.0', 'latest'])
  })

  it('a pre-release or a dirty build never moves latest', () => {
    expect(tagsFor('v0.1.0-rc.1')).toEqual(['v0.1.0-rc.1'])
    expect(tagsFor('v0.1.0-3-gabc123-dirty')).toEqual(['v0.1.0-3-gabc123-dirty'])
    expect(tagsFor('abc1234')).toEqual(['abc1234'])
  })
})
