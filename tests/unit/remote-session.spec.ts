// Unit tests for action selection. The json-auth mint and guacConnectionName were removed with
// json-auth itself (ADR-010) — their cases (HMAC/AES/btoa) were dropped as dead;
// tests/unit/no-json-auth.spec.ts guards that the symbols stay absent.
import { describe, expect, it } from 'vitest'
import { ActionUnavailableError, resolveAction } from '../../server/services/remote-session'

describe('resolveAction', () => {
  const device = { actions: ['vnc', 'rdp'], default_action: null, type_default_action: 'vnc' }

  it('no request — the type default', () => {
    expect(resolveAction(device)).toBe('vnc')
  })

  it('device override beats the type default', () => {
    expect(resolveAction({ ...device, default_action: 'rdp' })).toBe('rdp')
  })

  it('an explicitly requested allowed action is returned', () => {
    expect(resolveAction(device, 'rdp')).toBe('rdp')
  })

  // The ws routes branch on the error class to tell "action not allowed" from
  // "host unreachable"; a message match would break on any rewording.
  it('an action outside the device actions throws ActionUnavailableError', () => {
    // toThrow(X) with an undefined X accepts any error — check the class explicitly.
    expect(ActionUnavailableError).toBeTypeOf('function')
    let err: unknown
    try { resolveAction(device, 'ssh') }
    catch (e) { err = e }
    expect(err).toBeInstanceOf(ActionUnavailableError)
  })
})
