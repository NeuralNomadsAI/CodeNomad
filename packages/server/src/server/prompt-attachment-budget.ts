import { PROMPT_INLINE_FILE_LIMITS } from "../api-types"

export type PromptAttachmentBudgetResult =
  | { ok: true }
  | { ok: false; reason: "invalid-data-uri" | "limit" }

export function validatePromptAttachmentBudget(
  pathname: string,
  method: string,
  body: unknown,
): PromptAttachmentBudgetResult {
  if (method !== "POST" || !/^\/api\/session\/[^/]+\/(?:prompt|command)\/?$/.test(pathname)) {
    return { ok: true }
  }
  if (!isRecord(body) || !Array.isArray(body.files)) return { ok: true }

  let inlineFiles = 0
  let inlineBytes = 0
  for (const file of body.files) {
    if (!isRecord(file) || typeof file.uri !== "string" || !/^data:/i.test(file.uri)) continue
    const size = decodedDataUriSize(file.uri)
    if (size === null) return { ok: false, reason: "invalid-data-uri" }

    inlineFiles += 1
    inlineBytes += size
    if (
      size > PROMPT_INLINE_FILE_LIMITS.maxFileBytes
      || inlineFiles > PROMPT_INLINE_FILE_LIMITS.maxFiles
      || inlineBytes > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
    ) {
      return { ok: false, reason: "limit" }
    }
  }

  return { ok: true }
}

function decodedDataUriSize(uri: string): number | null {
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const metadata = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  if (/;base64(?:;|$)/i.test(metadata)) {
    if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
    return (payload.length / 4) * 3 - padding
  }
  try {
    return Buffer.byteLength(decodeURIComponent(payload), "utf8")
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)
}
