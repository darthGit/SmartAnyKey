// Wizard progress.
//
// The rail leads to the first connection: point → type → device → creds (→ connect,
// the finish screen, not a step derived from data). "Teach signatures" and "scan"
// stayed but moved off the critical path into the `scale` track — on an empty
// install they are not needed for the first connect, and someone who had not read
// the spec hit them as mandatory (usable on-ramp; developer's decision 2026-09-17).
import { describe, expect, it } from 'vitest'
import { firstIncompleteStep, onboardingSteps } from '../../app/utils/onboardingProgress'

const empty = { pointsWithSubnet: 0, deviceTypes: 0, credentialSets: 0, signatures: 0, confirmedDevices: 0 }
const byKey = (counts: typeof empty) => Object.fromEntries(onboardingSteps(counts).map(s => [s.key, s]))

describe('onboardingProgress: first-connection rail', () => {
  it('rail_is_the_first_connection_path: four steps exactly in the AC-23 order', () => {
    const rail = onboardingSteps(empty).filter(s => s.track === 'connect').map(s => s.key)
    expect(rail).toEqual(['points', 'types', 'devices', 'credentials'])
  })

  it('done_derived_from_counts: state is read from data, no wizard_state table', () => {
    const s = byKey({ ...empty, pointsWithSubnet: 2, deviceTypes: 1 })
    expect(s.points!.done).toBe(true)
    expect(s.types!.done).toBe(true)
    expect(s.devices!.done).toBe(false)
    expect(s.credentials!.done).toBe(false)
  })

  it('device_step_reads_devices_count: the "device" step is the presence of a device', () => {
    expect(byKey({ ...empty, confirmedDevices: 3 }).devices!.done).toBe(true)
  })

  it('first_incomplete_ignores_scale_track: re-open does not jump to "teach", it is off the rail', () => {
    // everything for connect is done, no signatures → the wizard treats the rail as complete
    expect(firstIncompleteStep({
      pointsWithSubnet: 1, deviceTypes: 1, credentialSets: 1, confirmedDevices: 1, signatures: 0,
    })).toBeNull()
  })

  it('first_incomplete_walks_the_rail', () => {
    expect(firstIncompleteStep(empty)).toBe('points')
    expect(firstIncompleteStep({ ...empty, pointsWithSubnet: 2, deviceTypes: 1 })).toBe('devices')
    expect(firstIncompleteStep({ ...empty, pointsWithSubnet: 1, deviceTypes: 1, confirmedDevices: 1 })).toBe('credentials')
  })

  it('scale_track_kept_not_deleted: "teach" stays a step, just on another track', () => {
    const teach = byKey({ ...empty, signatures: 4 }).teach
    expect(teach!.track).toBe('scale')
    expect(teach!.done).toBe(true)
  })
})
