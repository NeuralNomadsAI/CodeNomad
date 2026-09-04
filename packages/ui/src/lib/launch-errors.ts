import { OPENCODE_V2_REQUIRED_ERROR_CODE } from "../../../server/src/api-types"

export function formatLaunchErrorMessage(
  error: unknown,
  fallbackMessage: string,
  invalidConfigMessage: string,
  openCodeV2RequiredMessage?: string,
): string {
  if (!error) {
    return fallbackMessage
  }

  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
  if (openCodeV2RequiredMessage && raw.includes(OPENCODE_V2_REQUIRED_ERROR_CODE)) {
    return openCodeV2RequiredMessage
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const configError = formatConfigError(parsed, invalidConfigMessage)
    if (configError) return configError
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string") {
      return (parsed as any).error
    }
  } catch {
    // ignore JSON parse errors
  }

  return raw
}

function formatConfigError(value: unknown, invalidConfigMessage: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  type ConfigErrorDetails = {
    path?: unknown
    message?: unknown
    issues?: unknown
    dir?: unknown
    suggestion?: unknown
  }
  const error = value as ConfigErrorDetails & { name?: unknown; _tag?: unknown; data?: ConfigErrorDetails }
  const name = typeof error.name === "string" ? error.name : error._tag
  if (!["ConfigInvalidError", "ConfigJsonError", "ConfigFrontmatterError", "ConfigDirectoryTypoError"].includes(String(name))) return undefined
  const details = error.data && typeof error.data === "object" ? error.data : error

  const lines = [invalidConfigMessage]
  if (typeof details.path === "string" && details.path.trim()) lines.push(details.path.trim())
  if (typeof details.message === "string" && details.message.trim()) lines.push(details.message.trim())
  const dir = typeof details.dir === "string" ? details.dir.trim() : ""
  const suggestion = typeof details.suggestion === "string" ? details.suggestion.trim() : ""
  if (dir && suggestion) lines.push(`${dir} → ${suggestion}`)
  else if (dir || suggestion) lines.push(dir || suggestion)
  if (Array.isArray(details.issues)) {
    for (const issue of details.issues) {
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
