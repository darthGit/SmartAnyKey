// RED (finding of the live pass 2026-09-17).
//
// The click action = data: device override → the TYPE default. But
// the type default may be a protocol the device does NOT have (type "cash register" = vnc,
// while a particular register speaks only ssh) — and then a click opened a panel with "This device
// has no graphical action" instead of a session. A dead end instead of work: a person
// who went through the wizard has no way to learn they must go into "Default action".
import { describe, expect, it } from 'vitest'
import { resolveDeviceAction } from '../../app/utils/device-action'

const dev = (actions: string[], def: string | null = null) => ({ actions, default_action: def })

describe('resolveDeviceAction', () => {
  it('explicit_action_wins: an explicitly requested action beats everything', () => {
    expect(resolveDeviceAction(dev(['ssh', 'vnc'], 'vnc'), 'rdp', 'ssh')).toBe('rdp')
  })

  it('device_override_wins_over_type: the device override beats the type default', () => {
    expect(resolveDeviceAction(dev(['ssh', 'vnc'], 'ssh'), undefined, 'vnc')).toBe('ssh')
  })

  it('type_default_used_when_device_has_none', () => {
    expect(resolveDeviceAction(dev(['vnc', 'ssh']), undefined, 'vnc')).toBe('vnc')
  })

  it('falls_back_when_type_default_not_supported: type default not among the protocols → the device first action', () => {
    // exactly this case produced the red panel on the live pass
    expect(resolveDeviceAction(dev(['ssh']), undefined, 'vnc')).toBe('ssh')
  })

  it('falls_back_when_device_override_not_supported: a broken override does not lead to a dead end either', () => {
    expect(resolveDeviceAction(dev(['ssh', 'web'], 'rdp'), undefined, 'vnc')).toBe('ssh')
  })

  it('no_actions_at_all_is_empty: a device without protocols → empty, not an invented action', () => {
    expect(resolveDeviceAction(dev([]), undefined, 'vnc')).toBe('')
  })

  it('explicit_action_is_not_second_guessed: an explicit menu choice is not substituted', () => {
    // the menu shows only the device actions, so a substitution here would hide a real error
    expect(resolveDeviceAction(dev(['ssh']), 'vnc', 'ssh')).toBe('vnc')
  })
})
