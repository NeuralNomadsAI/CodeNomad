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

    // The generated client reports undeclared HTTP statuses as a bare reason
    // (for example "UnexpectedStatus" with { status: 500 } as the cause),
    // which hides the real failure in send dialogs. Surface the status code.
    if (candidate.reason === "UnexpectedStatus" && Number.isInteger(candidate.cause?.status)) {
      return `Unexpected status ${candidate.cause.status}`
    }

    const nested = extract(candidate.cause) ?? extract(candidate.error) ?? extract(candidate.body)
    if (nested) return nested

    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim()
    return undefined
  }

  return extract(error) ?? fallback
}
