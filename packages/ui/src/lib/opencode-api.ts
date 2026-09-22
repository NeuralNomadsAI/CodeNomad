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

    // The generated client reports undeclared HTTP statuses as a bare reason
    // (for example "UnexpectedStatus" with { status: 500 } as the cause),
    // which hides the real failure in send dialogs. Surface the status code
    // only when no deeper detail exists.
    if (candidate.reason === "UnexpectedStatus") {
      const status = Number(candidate.cause?.status)
      if (Number.isInteger(status) && status >= 100 && status <= 599) return `Unexpected status ${status}`
    }

    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim()
    return undefined
  }

  return extract(error) ?? fallback
}
