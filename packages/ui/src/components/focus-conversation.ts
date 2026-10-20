export function findConversationStream(root: ParentNode | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>(".message-stream") ?? null
}

export function focusConversationStream(root: ParentNode | null | undefined): boolean {
  const stream = findConversationStream(root)
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
