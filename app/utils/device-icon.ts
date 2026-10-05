// Device-type icon resolver. Model: `device_type.icon` = an emoji (client-owned,
// domain-agnostic, no library). Legacy seed values — semantic keys — stay
// supported through a back-compat map; empty → 🔌.
const LEGACY: Record<string, string> = {
  'cash-register': '💰',
  'self-checkout': '🛒',
  'desktop': '🖥️',
  'music': '🎵',
  'router': '📡',
}

export function resolveDeviceIcon(icon: string | null | undefined): string {
  if (!icon)
    return '🔌'
  return LEGACY[icon] ?? icon
}
