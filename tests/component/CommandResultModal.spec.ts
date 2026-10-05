// @vitest-environment nuxt
// RED (render part): the modal shows stdout/stderr, an exit-code badge,
// the duration and a copy button for a finished task_run. Live updates via
// Realtime are checked manually. The CommandResultModal.vue component does not
// exist yet → the suite fails.
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CommandResultModal from '../../app/components/CommandResultModal.vue'

const doneRun = {
  id: 'r1', label: 'status', status: 'done', error: null,
  result: { stdout: 'service active\n', stderr: '', exitCode: 0 },
  started_at: '2026-07-14T10:00:00Z', finished_at: '2026-07-14T10:00:02Z',
}

describe('CommandResultModal (AC-3)', () => {
  it('renders_output_exit_badge_duration_and_copy', async () => {
    await mountSuspended(CommandResultModal, { props: { run: doneRun, open: true } })
    const body = document.body.textContent ?? ''
    expect(body).toContain('service active')
    // the exit-code badge shows 0 (we check the element itself — textContent runs together)
    expect(document.body.querySelector('[data-testid="exit-badge"]')?.textContent).toContain('0')
    // the duration (2s) is shown
    expect(body).toMatch(/2\s*(s|с|ms|мс)/i)
    // the copy-output button
    const copy = Array.from(document.body.querySelectorAll('button'))
      .some(b => (b.getAttribute('data-testid') === 'copy-output') || /copy|копі/i.test(b.textContent ?? ''))
    expect(copy).toBe(true)
  })
})
