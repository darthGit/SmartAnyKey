// RED: auto-diff — comparing observations of labelled samples of ≥2 types
// → distinguishing signals (present-in-A / absent-in-B).
// Module app/utils/signalDiff does not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { signalDiff } from '../../app/utils/signalDiff'
import type { Observation } from '../../server/repositories/scanner'

const mikrotik: Observation = {
  ip: '10.0.0.1',
  ports: [{ port: 22, proto: 'tcp' }, { port: 8291, proto: 'tcp', product: 'MikroTik RouterOS' }],
  osGuess: 'RouterOS',
}
const linuxBox: Observation = {
  ip: '10.0.0.2',
  ports: [{ port: 22, proto: 'tcp' }, { port: 80, proto: 'tcp', product: 'nginx' }],
  osGuess: 'Linux 5.x',
}

describe('signalDiff (AC-2)', () => {
  it('highlights distinguishing signals of ≥2 types', () => {
    const diff = signalDiff([
      { typeId: 'router', obs: mikrotik },
      { typeId: 'server', obs: linuxBox },
    ])
    // port 8291 only in router, 80 only in server → both distinguishing
    expect(diff).toContainEqual(expect.objectContaining({ typeId: 'router', signal_type: 'port', pattern: '8291' }))
    expect(diff).toContainEqual(expect.objectContaining({ typeId: 'server', signal_type: 'port', pattern: '80' }))
  })

  it('shared signals are not distinguishing', () => {
    const diff = signalDiff([
      { typeId: 'router', obs: mikrotik },
      { typeId: 'server', obs: linuxBox },
    ])
    // port 22 in both types → must not be in the diff
    expect(diff.some(d => d.signal_type === 'port' && d.pattern === '22')).toBe(false)
  })

  it('<2 types → empty diff (nothing to compare)', () => {
    expect(signalDiff([{ typeId: 'router', obs: mikrotik }])).toEqual([])
  })
})
