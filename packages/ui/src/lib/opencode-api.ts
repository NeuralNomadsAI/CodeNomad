export function getOpencodeErrorMessage(error: unknown, fallback: string): string {
  const seen = new Set<unknown>()

  const extract = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined
    if (!value || typeof value !== "object" || seen.has(value)) return undefined
    seen.add(value)

    const candidate = value as any
    const direct = [candidate.data?.message, candidate.body?.message, candidate.error]
      .find((item) => typeof item === "string" && item.trim())
    if (direct) return direct.trim()

    const nested = extract(candidate.cause) ?? extract(candidate.error) ?? extract(candidate.body)
    if (nested) return nested

    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim()
    return undefined
  }

  return extract(error) ?? fallback
}
