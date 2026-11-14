import { activateSessionSurface, getSessionSurface } from "./session-surface"

export interface FilePreviewTarget {
  kind?: "workspace" | "diff"
  sessionId: string
  slug: string
  directory: string
  serviceDirectory?: string
  path: string
  originalPath?: string | null
  scope?: "staged" | "unstaged"
  commit?: string
  subject?: string
}

export const getFilePreview = (instanceId: string) => {
  const surface = getSessionSurface({ instanceId, sessionId: null })
  return surface.kind === "file" ? surface.target : null
}
export function openFilePreview(instanceId: string, target: FilePreviewTarget) {
  activateSessionSurface({ instanceId, sessionId: target.sessionId }, { kind: "file", target })
}
export function closeFilePreview(instanceId: string) {
  const target = getFilePreview(instanceId)
  if (target) activateSessionSurface({ instanceId, sessionId: target.sessionId }, { kind: "conversation" })
}
