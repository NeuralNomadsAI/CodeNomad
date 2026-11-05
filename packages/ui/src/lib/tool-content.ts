import type { ToolFileContent } from "@opencode/client"
import { isSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { localTransport, resolveBackendUrl, type BackendTransport } from "./backend-transport"

/** Images stay in native content; text projections must not stringify their bytes. */
export function isToolImageContent(value: unknown): value is ToolFileContent {
  if (!value || typeof value !== "object") return false
  const part = value as Partial<ToolFileContent>
  return part.type === "file" && typeof part.mime === "string" && /^image\//i.test(part.mime)
    && typeof part.uri === "string"
}

export function toolImageSource(file: ToolFileContent, backend: string | Pick<BackendTransport, "url"> = {
  url: path => resolveBackendUrl(localTransport.baseUrl, path, "append-trimmed"),
}): string | undefined {
  // A large image that a transcript page deferred; CodeNomad serves its bytes.
  if (isSessionMediaPath(file.uri)) return typeof backend === "string"
    ? resolveBackendUrl(backend, file.uri, /^https?:\/\//i.test(backend) ? "url" : "append-trimmed") : backend.url(file.uri)
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
