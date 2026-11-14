import { batch, createSignal } from "solid-js"
import type { FilePreviewTarget } from "./files-preview"
import type { MissionReaderTarget } from "./mission-view-state"
import { getTabViewState, updateTabViewState } from "./tab-view-state"
import { isInstanceOccurrenceOpen, onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

export type SurfaceContext = { instanceId: string; sessionId: string | null }
export type CentralSurface =
  | { kind: "conversation" }
  | { kind: "web"; sessionId: string }
  | { kind: "file"; target: FilePreviewTarget }
  | { kind: "mission"; target: MissionReaderTarget }

const conversation: CentralSurface = { kind: "conversation" }
const [files, setFiles] = createSignal<ReadonlyMap<string, FilePreviewTarget>>(new Map())
const intents = new Map<string, object>()

/** Saved browser modes and Mission readers are the version-one foreground projection.
 * Files have a runtime-only, session/worktree-bound lifetime. */
export function getSessionSurface({ instanceId, sessionId }: SurfaceContext): CentralSurface {
  const view = getTabViewState(instanceId)
  if (view.missions?.reader) return { kind: "mission", target: view.missions.reader }
  const file = files().get(instanceId)
  if (file && (sessionId === null || file.sessionId === sessionId)) return { kind: "file", target: file }
  if (sessionId && view.previews?.[sessionId]?.mode === "preview") return { kind: "web", sessionId }
  return conversation
}

/** Every explicit central-view gesture supersedes pending activation in this occurrence. */
export function activateSessionSurface(ctx: SurfaceContext, surface: CentralSurface): void {
  intents.delete(ctx.instanceId)
  batch(() => {
    const view = getTabViewState(ctx.instanceId)
    let previews = view.previews
    for (const [id, preview] of Object.entries(previews ?? {})) {
      if (ctx.sessionId !== null && id !== ctx.sessionId && surface.kind !== "mission") continue
      const mode = surface.kind === "web" && id === surface.sessionId ? "preview" : "chat"
      if (preview.mode !== mode) previews = { ...previews, [id]: { ...preview, mode } }
    }
    const reader = surface.kind === "mission" ? surface.target : undefined
    updateTabViewState(ctx.instanceId, {
      ...(previews === view.previews ? {} : { previews }),
      ...(reader === view.missions?.reader ? {} : { missions: { ...view.missions, reader } }),
    })
    const target = surface.kind === "file" ? surface.target : undefined
    if (files().get(ctx.instanceId) !== target) setFiles(previous => {
      const next = new Map(previous)
      if (target) next.set(ctx.instanceId, target)
      else next.delete(ctx.instanceId)
      return next
    })
  })
}

export function captureSessionSurfaceIntent(ctx: SurfaceContext) {
  const token = {}
  intents.set(ctx.instanceId, token)
  return {
    current: () => intents.get(ctx.instanceId) === token && isInstanceOccurrenceOpen(ctx.instanceId),
    release: () => { if (intents.get(ctx.instanceId) === token) intents.delete(ctx.instanceId) },
  }
}

export function invalidateSessionSurfaceIntent(instanceId: string): void { intents.delete(instanceId) }

/** Passive display reconciliation yields to an admitted foreground action. */
export function hasPendingSessionSurfaceIntent(instanceId: string): boolean { return intents.has(instanceId) }

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  intents.delete(event.instanceId)
  if (event.type === "removed") setFiles(previous => {
    const next = new Map(previous)
    next.delete(event.instanceId)
    return next
  })
})
