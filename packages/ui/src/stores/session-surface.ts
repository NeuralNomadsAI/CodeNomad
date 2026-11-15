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
const reconciliations = new Map<string, Map<string, () => void>>()

export type SessionSurfaceIntent = ReturnType<typeof captureSessionSurfaceIntent>

/** A synchronous gesture, or a synchronous step of the gesture admitted before an await. */
export function sessionSurfaceGesture(ctx: SurfaceContext, apply: (intent: SessionSurfaceIntent) => void, intent?: SessionSurfaceIntent): void {
  if (intent) {
    if (intent.current()) apply(intent)
    return
  }
  const admitted = captureSessionSurfaceIntent(ctx)
  try { if (admitted.current()) apply(admitted) }
  finally { admitted.release() }
}

/** Passive callers retain only their latest reconciliation and recheck their data fences on settlement. */
export function reconcileSessionSurface(instanceId: string, key: string, apply: () => void): void {
  if (!intents.has(instanceId)) { apply(); return }
  const pending = reconciliations.get(instanceId) ?? new Map()
  pending.set(key, apply)
  reconciliations.set(instanceId, pending)
}

function settle(instanceId: string): void {
  const pending = reconciliations.get(instanceId)
  reconciliations.delete(instanceId)
  if (isInstanceOccurrenceOpen(instanceId)) batch(() => { for (const apply of pending?.values() ?? []) apply() })
}

/** File lifetime/status reconciliation changes only the still-matching runtime target. */
export function reconcileFileSurface(instanceId: string, previous: FilePreviewTarget, target?: FilePreviewTarget): void {
  reconcileSessionSurface(instanceId, "file-reader", () => {
    if (files().get(instanceId) !== previous) return
    setFiles(current => {
      const next = new Map(current)
      if (target) next.set(instanceId, target)
      else next.delete(instanceId)
      return next
    })
  })
}

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
export function activateSessionSurface(ctx: SurfaceContext, surface: CentralSurface, intent?: SessionSurfaceIntent): void {
  sessionSurfaceGesture(ctx, () => writeSessionSurface(ctx, surface), intent)
}

function writeSessionSurface(ctx: SurfaceContext, surface: CentralSurface): void {
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
    release: () => {
      if (intents.get(ctx.instanceId) !== token) return
      intents.delete(ctx.instanceId)
      settle(ctx.instanceId)
    },
  }
}

export function invalidateSessionSurfaceIntent(instanceId: string): void {
  intents.delete(instanceId)
  settle(instanceId)
}

/** Passive display reconciliation yields to an admitted foreground action. */
export function hasPendingSessionSurfaceIntent(instanceId: string): boolean { return intents.has(instanceId) }

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  intents.delete(event.instanceId)
  reconciliations.delete(event.instanceId)
  if (event.type === "removed") setFiles(previous => {
    const next = new Map(previous)
    next.delete(event.instanceId)
    return next
  })
})
