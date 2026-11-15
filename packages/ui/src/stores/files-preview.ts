import { activateSessionSurface, getSessionSurface, reconcileFileSurface, sessionSurfaceGesture, type SessionSurfaceIntent } from "./session-surface"
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
  const ctx = { instanceId, sessionId: target.sessionId }
  sessionSurfaceGesture(ctx, admitted => activateSessionSurface(ctx, { kind: "file", target }, admitted), intent)
}
export function closeFilePreview(instanceId: string, intent?: SessionSurfaceIntent) {
  const target = getFilePreview(instanceId)
  if (target) {
    const ctx = { instanceId, sessionId: target.sessionId }
    sessionSurfaceGesture(ctx, admitted => activateSessionSurface(ctx, { kind: "conversation" }, admitted), intent)
  }
}
export function reconcileFilePreviewLifetime(instanceId: string) {
  const target = getFilePreview(instanceId)
  if (target) reconcileFileSurface(instanceId, target)
}
