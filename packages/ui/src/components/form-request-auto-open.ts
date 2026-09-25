interface ActiveInterruption {
  kind: string
  id: string
}

export function getFormRequestAutoOpenId(
  active: ActiveInterruption | null | undefined,
  lastOpenedId: string | null,
): string | null {
  if (active?.kind !== "form" || active.id === lastOpenedId) return null
  return active.id
}
