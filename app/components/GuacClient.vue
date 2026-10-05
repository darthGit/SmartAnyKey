<script setup lang="ts">
// ADR-010: Guacamole.Client ↔ Nitro-ws (/api/guac/:id) ↔ guacd. Mirror of
// SshTerminal.vue (ADR-007), but graphical: display canvas, mouse, keyboard.
// Resize — two mechanisms together:
//   1) client.sendSize(pane) — servers that can (RDP, VNC with RandR, like our
//      dev container) adapt the resolution to the pane and fill it.
//   2) letterbox fit + centring — fixed-screen servers (a real
//      till) ignore (1), so we scale the framebuffer down and centre it, so
//      the whole screen is visible, not the top-left corner.
// Keyboard is bound to the pane element (scoped), so several panes do not
// intercept each other. States via t() (ADR-006). Tailwind (ADR-004).
import Guacamole from 'guacamole-common-js'
import type { Client, Display, GuacStatus, Keyboard } from 'guacamole-common-js'

const props = defineProps<{ deviceId: string, action: 'vnc' | 'rdp' }>()
const { t } = useI18n()
const session = useSupabaseSession()

const el = ref<HTMLElement | null>(null)
const status = ref<'connecting' | 'open' | 'closed' | 'error'>('connecting')
const errorMsg = ref('')

let client: Client | null = null
let display: Display | null = null
let keyboard: Keyboard | null = null
let ro: ResizeObserver | null = null
let raf = 0
let sendTimer: ReturnType<typeof setTimeout> | undefined
let scale = 1 // current canvas→pane scale (for recalculating mouse coordinates)

// guac status (our ws sends message = our code 'auth'/'host'/'action'; guacd —
// its own codes/texts) → localised string
function errText(code: string): string {
  if (code === 'auth')
    return t('guac.authError')
  if (code === 'host')
    return t('guac.hostUnreachable')
  if (code === 'cred')
    return t('guac.credUndecryptable')
  if (code === 'action')
    return t('guac.actionUnavailable')
  if (code === 'rate')
    return t('guac.rateLimited')
  return t('guac.error', { message: code })
}

// Fit the framebuffer into the pane keeping proportions. Centring is flex on the
// container: display.getElement() (bounds) has layout size = the scaled
// framebuffer (guacamole sets bounds.width/height itself), so flex centres
// it without manual positioning.
function fit() {
  if (!display || !el.value)
    return
  const dw = display.getWidth()
  const dh = display.getHeight()
  const cw = el.value.clientWidth
  const ch = el.value.clientHeight
  if (!dw || !dh || !cw || !ch)
    return
  scale = Math.min(cw / dw, ch / dh)
  display.scale(scale)
}

// fit is per-frame and cheap (CSS scale only), so it NEVER overflows the pane,
// however the framebuffer jumps during the splitter animation.
function scheduleFit() {
  if (raf)
    return
  raf = requestAnimationFrame(() => {
    raf = 0
    fit()
  })
}

// sendSize is debounced: the pane has a width transition (sidebar), so a resize fires
// dozens of events; without debounce it is a resize storm on the server (fb jumps, overflow).
// Send once after it settles → a capable server (container/RDP) adapts the
// resolution to the final size; fixed screens ignore it (fit saves them).
function scheduleSend() {
  clearTimeout(sendTimer)
  sendTimer = setTimeout(() => {
    if (client && el.value)
      client.sendSize(el.value.clientWidth, el.value.clientHeight)
  }, 200)
}

onMounted(() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // WebSocketTunnel appends "?"+data itself → tunnelURL without a query; the token and
  // action go through client.connect(data).
  const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/api/guac/${props.deviceId}`)
  client = new Guacamole.Client(tunnel)

  display = client.getDisplay()
  el.value!.appendChild(display.getElement())
  // The server changed resolution (reply to sendSize / its own RandR) →
  // recompute fit (no sendSize, to avoid a feedback loop).
  display.onresize = () => scheduleFit()

  client.onstatechange = (state) => {
    // 3 = CONNECTED, 5 = DISCONNECTED (guacamole-common-js states)
    if (state === 3) {
      status.value = 'open'
      scheduleSend() // adapt the resolution to the pane
      scheduleFit()
    }
    else if (state === 5 && status.value !== 'error') {
      status.value = 'closed'
    }
  }
  client.onerror = (guacStatus: GuacStatus) => {
    status.value = 'error'
    errorMsg.value = errText(guacStatus?.message ?? 'error')
    client?.disconnect()
  }

  // Mouse: Guacamole.Mouse gives coordinates in CSS pixels of the scaled element
  // → divide by scale to land in the target's framebuffer pixels.
  const mouse = new Guacamole.Mouse(display.getElement())
  const sendMouse = (s: { x: number, y: number }) => {
    el.value?.focus()
    client?.sendMouseState({ ...s, x: s.x / scale, y: s.y / scale })
  }
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = sendMouse

  // Keyboard — on the pane element (scoped), not on document
  keyboard = new Guacamole.Keyboard(el.value!)
  keyboard.onkeydown = keysym => client?.sendKeyEvent(1, keysym)
  keyboard.onkeyup = keysym => client?.sendKeyEvent(0, keysym)

  const token = session.value?.access_token ?? ''
  client.connect(`token=${encodeURIComponent(token)}&action=${props.action}`)

  // The pane resized → per-frame fit (never overflows) + debounced sendSize.
  ro = new ResizeObserver(() => { scheduleFit(); scheduleSend() })
  ro.observe(el.value!)
})

onBeforeUnmount(() => {
  if (raf)
    cancelAnimationFrame(raf)
  clearTimeout(sendTimer)
  ro?.disconnect()
  // Guacamole.Keyboard removes listeners when the element is removed; explicitly reset handlers
  if (keyboard) {
    keyboard.onkeydown = null
    keyboard.onkeyup = null
  }
  client?.disconnect()
})
</script>

<template>
  <!-- `isolate` (isolation:isolate) is required: guac's base layer is a canvas at
       z-index:-1; without its own stacking context that -1 bubbles up and paints
       the canvas behind the pane background (black screen with a live cursor). isolate
       keeps negative z local. No bg here (it would cover the canvas). -->
  <div
    ref="el"
    tabindex="0"
    class="isolate relative flex items-center justify-center h-full w-full overflow-hidden outline-none"
  >
    <div
      v-if="status !== 'open'"
      class="absolute inset-x-0 top-0 px-3 py-1 text-xs font-mono pointer-events-none"
      :class="status === 'error' ? 'text-error' : 'text-muted'"
    >
      {{ status === 'connecting' ? t('guac.connecting') : status === 'error' ? errorMsg : t('guac.closed') }}
    </div>
  </div>
</template>
