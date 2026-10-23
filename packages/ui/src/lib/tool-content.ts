import type { ToolFileContent } from "@opencode/client"
import { isSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { CODENOMAD_API_BASE } from "./api-base"

/** Images stay in native content; text projections must not stringify their bytes. */
export function isToolImageContent(value: unknown): value is ToolFileContent {
  if (!value || typeof value !== "object") return false
  const part = value as Partial<ToolFileContent>
  return part.type === "file" && typeof part.mime === "string" && /^image\//i.test(part.mime)
    && typeof part.uri === "string"
}

export function toolImageSource(file: ToolFileContent, apiBase = CODENOMAD_API_BASE): string | undefined {
  // A large image that a transcript page deferred; CodeNomad serves its bytes.
  if (isSessionMediaPath(file.uri)) return `${(apiBase ?? "").replace(/\/+$/, "")}${file.uri}`
  if (/^data:/i.test(file.uri)) {
    const header = file.uri.slice(0, file.uri.indexOf(",") + 1).toLowerCase()
    return header === `data:${file.mime.toLowerCase()};base64,` ? file.uri : undefined
  }
  try {
    const url = new URL(file.uri)
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return file.uri
  } catch { /* Non-URL/local file references cannot be loaded by the renderer. */ }
  return undefined
}
