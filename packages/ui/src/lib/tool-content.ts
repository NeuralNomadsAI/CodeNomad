import type { ToolFileContent } from "@opencode/client"
import { CODENOMAD_API_BASE } from "./api-base"
import { authorizedMediaSource, trustedMediaPolicy, type MediaPolicy } from "./media-policy"

/** Images stay in native content; text projections must not stringify their bytes. */
export function isToolFileContent(value: unknown): value is ToolFileContent {
  if (!value || typeof value !== "object") return false
  const part = value as Partial<ToolFileContent>
  return part.type === "file" && typeof part.mime === "string" && typeof part.uri === "string"
}

export function isToolImageContent(value: unknown): value is ToolFileContent {
  return isToolFileContent(value) && /^image\//i.test(value.mime)
}

export function toolImageSource(file: ToolFileContent, apiBase = CODENOMAD_API_BASE, policy: MediaPolicy = trustedMediaPolicy): string | undefined {
  return authorizedMediaSource(file, policy, apiBase)
}
