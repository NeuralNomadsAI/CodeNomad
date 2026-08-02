export function formatLaunchErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!error) {
    return fallbackMessage
  }

  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)

  try {
    const parsed = JSON.parse(raw) as unknown
    const configError = formatConfigInvalidError(parsed)
    if (configError) return configError
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string") {
      return (parsed as any).error
    }
  } catch {
    // ignore JSON parse errors
  }

  return raw
}

function formatConfigInvalidError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const error = value as { name?: unknown; data?: { path?: unknown; issues?: unknown } }
  if (error.name !== "ConfigInvalidError" || !error.data || typeof error.data !== "object") return undefined

  const lines = [error.name]
  if (typeof error.data.path === "string" && error.data.path.trim()) lines.push(error.data.path.trim())
  if (Array.isArray(error.data.issues)) {
    for (const issue of error.data.issues) {
      if (!issue || typeof issue !== "object") continue
      const candidate = issue as { path?: unknown; message?: unknown }
      const location = Array.isArray(candidate.path) ? candidate.path.map(String).join(".") : ""
      const message = typeof candidate.message === "string" ? candidate.message.trim() : ""
      if (location && message) lines.push(`${location}: ${message}`)
      else if (message) lines.push(message)
    }
  }

  return lines.join("\n")
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
