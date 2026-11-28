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
const generations = new Map<string, { value: number }>()
export type SurfaceGesture = ReturnType<typeof beginGesture>

export function observeSurfaceGesture({ instanceId }: SurfaceContext) {
  const occurrence = generations.get(instanceId)
  const generation = occurrence?.value
  return { current: () => generations.get(instanceId) === occurrence && occurrence?.value === generation && isInstanceOccurrenceOpen(instanceId) }
}

/** Admit once, before awaiting; only a later gesture or a closed occurrence retires it. */
export function beginGesture({ instanceId }: SurfaceContext) {
  if (!isInstanceOccurrenceOpen(instanceId)) return { current: () => false }
  const occurrence = generations.get(instanceId) ?? { value: 0 }
  generations.set(instanceId, occurrence)
  occurrence.value++
  return observeSurfaceGesture({ instanceId, sessionId: null })
}

/** Passive file reconciliation applies to the current matching target immediately. */
export function reconcileFileSurface(instanceId: string, previous: FilePreviewTarget, target?: FilePreviewTarget): void {
  if (files().get(instanceId) !== previous) return
  setFiles(current => {
    const next = new Map(current)
    if (target) next.set(instanceId, target)
    else next.delete(instanceId)
    return next
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
export function applySurface(ctx: SurfaceContext, surface: CentralSurface, gesture = beginGesture(ctx)): void {
  if (!gesture.current()) return
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
    setFiles(previous => {
      if (!target && !previous.has(ctx.instanceId)) return previous
      const next = new Map(previous)
      if (target) next.set(ctx.instanceId, target)
      else next.delete(ctx.instanceId)
      return next
    })
  })
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  generations.delete(event.instanceId)
  if (event.type === "removed") setFiles(previous => {
    const next = new Map(previous)
    next.delete(event.instanceId)
    return next
  })
})
