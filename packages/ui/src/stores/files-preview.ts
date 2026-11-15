import { activateSessionSurface, getSessionSurface, reconcileFileSurface, type SessionSurfaceIntent } from "./session-surface"
export { reconcileFileSurface as reconcileFilePreview } from "./session-surface"

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
export function openFilePreview(instanceId: string, target: FilePreviewTarget, intent?: SessionSurfaceIntent) {
  activateSessionSurface({ instanceId, sessionId: target.sessionId }, { kind: "file", target }, intent)
}
export function closeFilePreview(instanceId: string, intent?: SessionSurfaceIntent) {
  const target = getFilePreview(instanceId)
  if (target) activateSessionSurface({ instanceId, sessionId: target.sessionId }, { kind: "conversation" }, intent)
}
export function reconcileFilePreviewLifetime(instanceId: string) {
  const target = getFilePreview(instanceId)
  if (target) reconcileFileSurface(instanceId, target)
}
