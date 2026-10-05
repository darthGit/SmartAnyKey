// @vitest-environment nuxt
// DeviceButton renders <a href> (middle-click → a new
// tab) and keeps the open/menu emits after the migration to the kit.
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DeviceButton from '../../app/components/DeviceButton.vue'
import type { Device, DeviceType } from '../../app/types/board'

const device: Device = {
  id: 'dev-1', point_id: 'p-1', type_id: 't-1', label: 'Каса 1',
  host: '10.0.0.5', actions: ['vnc', 'ssh'], default_action: 'vnc', sort: 0,
}
const type: DeviceType = {
  id: 't-1', slug: 'cash-register', name: 'Каса', icon: 'cash-register',
  color: '#8b5cf6', default_action: 'vnc', sort: 0,
}

describe('DeviceButton', () => {
  it('renders_anchor_href_and_emits', async () => {
    const wrapper = await mountSuspended(DeviceButton, { props: { device, type } })

    const anchor = wrapper.find('a')
    expect(anchor.exists()).toBe(true)
    expect(anchor.attributes('href')).toBe('/api/remote-session/dev-1')

    await anchor.trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual([device])

    await anchor.trigger('contextmenu', { clientX: 12, clientY: 34 })
    expect(wrapper.emitted('menu')?.[0]).toEqual([{ device, x: 12, y: 34 }])
  })
})
