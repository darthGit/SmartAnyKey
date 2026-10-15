<script setup lang="ts">
// ADR-007: xterm ↔ Nitro-ws (/api/terminal/:id) ↔ ssh2. FitAddon computes
// cols/rows for the container; ResizeObserver → fit()+ws resize. States
// connecting/closed/error via t() (ADR-006, no hardcoding). Tailwind, no
// scoped CSS (ADR-004).
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ deviceId: string }>()
const { t } = useI18n()
const session = useSupabaseSession()

const el = ref<HTMLElement | null>(null)
const status = ref<'connecting' | 'open' | 'closed' | 'error'>('connecting')
const errorMsg = ref('')

let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let ro: ResizeObserver | null = null
let raf = 0

// ws controller error codes → localised string
function errText(code: string): string {
  if (code === 'auth')
    return t('terminal.authError')
  if (code === 'host')
    return t('terminal.hostUnreachable')
  if (code === 'cred')
    return t('terminal.credUndecryptable')
  if (code === 'action')
    return t('terminal.actionUnavailable')
  if (code === 'rate')
    return t('terminal.rateLimited')
  return t('terminal.error', { message: code })
}

function sendResize() {
  if (!term || !fit)
    return
  fit.fit()
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
}

// Coalesce resize into 1 frame: an animated sidebar shift/resize (planned
// UI work) sends dozens of resize events — without this it
// floods the ws with resize frames and jerks the xterm reflow.
function scheduleResize() {
  if (raf)
    return
  raf = requestAnimationFrame(() => {
    raf = 0
    sendResize()
  })
}

onMounted(() => {
  term = new Terminal({
    // xterm measures the cell on a canvas, and a canvas font rejects `var()` (falls back
    // to 10px sans-serif) → cells wider than the glyphs, letters drawn spaced out.
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0e0e0e' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value!)
  fit.fit()

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const token = session.value?.access_token ?? ''
  ws = new WebSocket(`${proto}://${location.host}/api/terminal/${props.deviceId}?token=${encodeURIComponent(token)}`)
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    status.value = 'open'
    sendResize()
  }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      // text = control frame (error); tty arrives as binary
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'error') {
          status.value = 'error'
          errorMsg.value = errText(msg.code)
        }
      }
      catch { /* ignore */ }
    }
    else {
      term?.write(new Uint8Array(e.data))
    }
  }
  ws.onclose = () => {
    if (status.value !== 'error')
      status.value = 'closed'
  }
  ws.onerror = () => {
    if (status.value === 'connecting') {
      status.value = 'error'
      errorMsg.value = t('terminal.error', { message: 'ws' })
    }
  }

  term.onData((d) => {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'input', data: d }))
  })

  ro = new ResizeObserver(() => scheduleResize())
  ro.observe(el.value!)
})

onBeforeUnmount(() => {
  if (raf)
    cancelAnimationFrame(raf)
  ro?.disconnect()
  ws?.close()
  term?.dispose()
})
</script>

<template>
  <div class="relative h-full w-full bg-[#0e0e0e]">
    <div ref="el" class="h-full w-full" />
    <div
      v-if="status !== 'open'"
      class="absolute inset-x-0 top-0 px-3 py-1 text-xs font-mono pointer-events-none"
      :class="status === 'error' ? 'text-error' : 'text-muted'"
    >
      {{ status === 'connecting' ? t('terminal.connecting') : status === 'error' ? errorMsg : t('terminal.closed') }}
    </div>
  </div>
</template>
