export function canMarkSessionIdleSeen(input: {
  active: boolean
  visibilityState: DocumentVisibilityState
  focused: boolean
}): boolean {
  return input.active && input.visibilityState === "visible" && input.focused
}
