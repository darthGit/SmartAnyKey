// @vitest-environment nuxt
// Emits part (cursor positioning is checked manually):
// the menu shows the actions from device.actions, a choice emits select(action), closing
// emits close. The contract (emits + visible actions), not DOM classes.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DeviceContextMenu from '../../app/components/DeviceContextMenu.vue'
import type { Device } from '../../app/types/board'

// Teleport renders into document.body and is not cleaned up between tests → we clean it.
afterEach(() => { document.body.innerHTML = '' })

const device: Device = {
  id: 'dev-1', point_id: 'p-1', type_id: 't-1', label: 'Каса 1',
  host: '10.0.0.5', actions: ['vnc', 'ssh'], default_action: 'vnc', sort: 0,
}

describe('DeviceContextMenu', () => {
  it('emits_select_and_close', async () => {
    const wrapper = await mountSuspended(DeviceContextMenu, {
      props: { device, x: 100, y: 200 },
    })

    // Teleport → content in document.body; one action button per action.
    // The selector is targeted (`[data-action]`, like `[data-command-id]` below): counting
    // all buttons would mean "the menu has nothing but actions" — and that is no longer true
    // since file transfer (SFTP) added the "Files" item (a test must not
    // encode my model instead of the contract).
    const actionButtons = Array.from(document.body.querySelectorAll('[data-action]'))
    expect(actionButtons.length).toBe(device.actions.length)

    ;(actionButtons[0] as HTMLButtonElement).click()
    expect(wrapper.emitted('select')?.[0]).toEqual([device.actions[0]])

    // close on the backdrop overlay (update the selector when migrating to the kit menu)
    const backdrop = document.body.querySelector('.backdrop') as HTMLElement | null
    expect(backdrop).not.toBeNull()
    backdrop?.click()
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})

// RED: the "Commands" section — the type's commands come in via the `commands` prop
// (the parent fetches), rendered ONLY on an ssh-capable device; a click emits
// run-command with the id. The prop/section do not exist yet → fails.
const commands = [
  { id: 'cmd-1', name: 'Restart', body: 'systemctl restart x', interpreter: 'raw', confirm: false, timeout_s: 45 },
  { id: 'cmd-2', name: 'Status', body: 'systemctl status x', interpreter: 'raw', confirm: false, timeout_s: 45 },
]

describe('DeviceContextMenu — commands section (AC-1)', () => {
  it('shows_commands_only_for_ssh_capable_device', async () => {
    const wrapper = await mountSuspended(DeviceContextMenu, {
      props: { device, x: 10, y: 20, commands },
    })
    const items = document.body.querySelectorAll('[data-command-id]')
    expect(items.length).toBe(commands.length)
    ;(items[0] as HTMLButtonElement).click()
    expect(wrapper.emitted('run-command')?.[0]).toEqual(['cmd-1'])
  })

  it('hides_commands_section_for_non_ssh_device', async () => {
    const noSsh: Device = { ...device, actions: ['vnc', 'rdp'] }
    await mountSuspended(DeviceContextMenu, {
      props: { device: noSsh, x: 10, y: 20, commands },
    })
    expect(document.body.querySelectorAll('[data-command-id]').length).toBe(0)
  })
})
