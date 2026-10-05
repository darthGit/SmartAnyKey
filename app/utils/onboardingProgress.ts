// Onboarding progress: the done state of cold-start steps is derived from DB counts
// (no separate `wizard_state` table) + the first incomplete step for re-opening the
// wizard. Pure logic; the composable only supplies counts (client select, RLS-authenticated).
//
// Two tracks — a developer decision of 2026-09-17, not cosmetics:
//   `connect` — the rail to the first connection (point → type → device → creds);
//               the connect itself is the finish screen, not a step: the data has no
//               honest "the user connected" signal (the access audit lives in
//               credential_access_log, which is deny-all for the client), and inventing
//               a server route for a checkmark costs more than the checkmark;
//   `scale`   — "teach signatures" + scan: still there, but on an empty install it is
//               not needed for the first connect, yet it sat on the critical path and
//               read as mandatory (the on-ramp must not block the typical task).
export interface OnboardingCounts {
  pointsWithSubnet: number
  deviceTypes: number
  credentialSets: number
  signatures: number
  confirmedDevices: number
}

export type StepTrack = 'connect' | 'scale'

export interface StepState {
  key: string
  done: boolean
  track: StepTrack
}

const STEPS: { key: string, count: keyof OnboardingCounts, track: StepTrack }[] = [
  { key: 'points', count: 'pointsWithSubnet', track: 'connect' },
  { key: 'types', count: 'deviceTypes', track: 'connect' },
  { key: 'devices', count: 'confirmedDevices', track: 'connect' },
  { key: 'credentials', count: 'credentialSets', track: 'connect' },
  { key: 'teach', count: 'signatures', track: 'scale' },
]

export function onboardingSteps(counts: OnboardingCounts): StepState[] {
  return STEPS.map(s => ({ key: s.key, done: counts[s.count] >= 1, track: s.track }))
}

/** Where to open the wizard. Looks ONLY at the rail: `scale` does not hold the user at the start. */
export function firstIncompleteStep(counts: OnboardingCounts): string | null {
  return onboardingSteps(counts).find(s => s.track === 'connect' && !s.done)?.key ?? null
}
