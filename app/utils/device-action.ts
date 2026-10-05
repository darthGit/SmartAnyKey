// Which action a click on a device opens (the action is data).
//
// Order: explicitly requested (menu item) → device override → type default. New
// here is the last check: the resolved action must be among the device's protocols.
// Without it a "cash register" type with default `vnc` opened a vnc pane on a device
// that only speaks ssh, and the user saw "This device has no graphical action" — a dead
// end instead of a session (measured on a live clean-install run 2026-09-17).
//
// An explicit choice is NOT replaced: the menu shows only the device's own actions, so a
// mismatch there would be a real bug, better seen than silently fixed.
export function resolveDeviceAction(
  device: { actions: string[], default_action?: string | null },
  requested?: string,
  typeDefault?: string | null,
): string {
  if (requested)
    return requested
  const preferred = device.default_action ?? typeDefault ?? ''
  if (preferred && device.actions.includes(preferred))
    return preferred
  return device.actions[0] ?? ''
}
