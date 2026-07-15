export function focusConversationStream(root: ParentNode | null | undefined): boolean {
  const stream = root?.querySelector<HTMLElement>(".message-stream")
  if (!stream) return false

  try {
    stream.focus({ preventScroll: true })
  } catch {
    try {
      stream.focus()
    } catch {
      return false
    }
  }
  return true
}
