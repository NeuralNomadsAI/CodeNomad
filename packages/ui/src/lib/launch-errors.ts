export function formatLaunchErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!error) {
    return fallbackMessage
  }

  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)

  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string") {
      return (parsed as any).error
    }
  } catch {
    // ignore JSON parse errors
  }

  return raw
}

export function isMissingBinaryMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("opencode binary not found") ||
    normalized.includes("binary not found") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("binary is not executable") ||
    normalized.includes("enoent")
  )
}
