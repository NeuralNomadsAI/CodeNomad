import { applySurface, getSessionSurface, reconcileFileSurface, type SurfaceGesture } from "./session-surface"
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
export function openFilePreview(instanceId: string, target: FilePreviewTarget, gesture?: SurfaceGesture) {
  const ctx = { instanceId, sessionId: target.sessionId }
  applySurface(ctx, { kind: "file", target }, gesture)
}
export function closeFilePreview(instanceId: string, gesture?: SurfaceGesture) {
  const target = getFilePreview(instanceId)
  if (target) {
    const ctx = { instanceId, sessionId: target.sessionId }
    applySurface(ctx, { kind: "conversation" }, gesture)
  }
}
export function reconcileFilePreviewLifetime(instanceId: string) {
  const target = getFilePreview(instanceId)
  if (target) reconcileFileSurface(instanceId, target)
}
