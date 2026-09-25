export const NEW_WINDOW_ACCELERATOR = "CmdOrCtrl+Shift+N"

export function resolveFocusedLocalTarget<T>(focused: T | null, mru: T | null, isLocal: (value: T) => boolean): T | null {
  if (focused) return isLocal(focused) ? focused : null
  return mru && isLocal(mru) ? mru : null
}

export function resolveWindowTarget<T>(focused: T | null, mru: T | null): T | null {
  return focused ?? mru
}
