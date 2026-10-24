export const NEW_WINDOW_ACCELERATOR = "CmdOrCtrl+Shift+N"

export function resolveFocusedLocalTarget<T>(focused: T | null, mru: T | null, isLocal: (value: T) => boolean): T | null {
  if (focused) return isLocal(focused) ? focused : null
  return mru && isLocal(mru) ? mru : null
}

/** Actions owned by application windows (About, like Tauri's update flow): a
 * focused Preferences or remote window hands them to the most recent local window. */
export function resolveApplicationTarget<T>(focused: T | null, mru: T | null, isLocal: (value: T) => boolean): T | null {
  return resolveFocusedLocalTarget(focused, mru, isLocal) ?? resolveFocusedLocalTarget(null, mru, isLocal)
}

export function resolveWindowTarget<T>(focused: T | null, mru: T | null): T | null {
  return focused ?? mru
}
