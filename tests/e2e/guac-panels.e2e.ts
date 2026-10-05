// e2e skeleton — playwright, NOT run by vitest
// (glob include=tests/**/*.spec.ts; this is .e2e.ts). Lives apart, because it needs
// @playwright/test + `playwright install chromium` + a live VNC target — all
// of that is installed together with a live target, not by default. Driven by a script
// (cheaper than MCP).
//
// Target: a live VNC device from the dev seed; the RDP target is still to be chosen.
//
// fixme() keeps the wiring visible but stops the suite from failing until ready.
import { expect, test } from '@playwright/test'

const APP = process.env.E2E_APP_URL ?? 'http://localhost:3000'

test.describe('guac panels — independent (ADR-010)', () => {
  test.fixme('AC-1: the 2nd panel does not touch the 1st; closing one does not affect the others', async ({ page }) => {
    await page.goto(APP)
    // TODO: open VNC panel A, wait for the framebuffer; open B;
    // assert — canvas A still updates (not «connection does not exist»);
    // close A → B lives.
    expect(true).toBe(false)
  })

  test.fixme('AC-2: ≥3 panels stream simultaneously and independently', async () => {
    expect(true).toBe(false)
  })

  test.fixme('AC-3: live framebuffer + input (mouse/keyboard) + resize re-renders', async () => {
    expect(true).toBe(false)
  })

  test.fixme('AC-7: RDP action takes the same path as VNC', async () => {
    expect(true).toBe(false)
  })
})
