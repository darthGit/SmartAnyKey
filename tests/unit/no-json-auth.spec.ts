// RED: json-auth is eradicated. A namespace import (not named) — so the test stays
// valid AFTER the symbols are deleted (a named import of a missing one = compile error).
// Right now mint/build/name are still exported from remote-session.ts → fails.
import { describe, expect, it } from 'vitest'
import * as remoteSession from '../../server/services/remote-session'

const mod = remoteSession as Record<string, unknown>

describe('json-auth eradicated (AC-6)', () => {
  it('mintGuacToken removed', () => {
    expect(mod.mintGuacToken).toBeUndefined()
  })
  it('buildSessionUrl removed', () => {
    expect(mod.buildSessionUrl).toBeUndefined()
  })
  it('guacConnectionName removed', () => {
    expect(mod.guacConnectionName).toBeUndefined()
  })
  // connectionParameters stays (the bridge uses it for guacd parameters),
  // resolveAction stays — it is not json-auth.
  it('connectionParameters kept (the bridge needs it)', () => {
    expect(typeof mod.connectionParameters).toBe('function')
  })
})
