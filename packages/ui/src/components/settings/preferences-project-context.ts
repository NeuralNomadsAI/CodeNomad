import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { NativePreferencesRequest } from "../../lib/native/preferences-window"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { createEventRefreshScheduler } from "../../lib/event-refresh-scheduler"
import { normalizeWorkspacePath } from "../../stores/app-session-reconciliation"

type ProjectContext = Pick<NativePreferencesRequest, "instanceId" | "location">
const key = (value: ProjectContext) => JSON.stringify([value.instanceId, value.location?.directory, value.location?.workspaceID])

/** Preferences is a secondary renderer: resolve only its requested project, without
 *  hydrating the application store, discovering worktrees or opening a workspace.
 *  Backend workspace IDs do not survive restart. An absent ID can be replaced by
 *  one unambiguous exact-folder match, never an ancestor or arbitrary other project. */
export function createPreferencesProjectContext(
  request: Accessor<NativePreferencesRequest>,
  active: Accessor<boolean>,
  onRebound: (context: ProjectContext, current: () => boolean) => void,
) {
  const target = createMemo(() => ({ instanceId: request().instanceId, location: request().location }), undefined,
    { equals: (a, b) => key(a) === key(b) })
  const [resolved, setResolved] = createSignal<{ source: string; context: ProjectContext }>()
  // An explicitly closed occurrence must not silently turn into another tab of the same folder.
  const deleted = new Set<string>()
  const context = createMemo(() => {
    const value = resolved()
    return active() && value && (value.source === key(target()) || key(value.context) === key(target())) ? value.context : undefined
  })

  createEffect(() => {
    const source = target(), sourceKey = key(source)
    const previous = untrack(context)
    const reusable = previous && key(previous) === sourceKey
    if (!reusable) setResolved(undefined)
    if (!source.instanceId) return
    const directory = source.location?.directory
    const sameFolder = (path: string) => Boolean(directory && normalizeWorkspacePath(path) === normalizeWorkspacePath(directory))
    let disposed = false, revision = 0, controller: AbortController | undefined, boundId = previous?.instanceId
    const current = (epoch: number) => !disposed && untrack(active) && revision === epoch && !deleted.has(source.instanceId!)

    const scheduler = createEventRefreshScheduler(async () => {
      if (disposed || !untrack(active) || deleted.has(source.instanceId!)) return
      const epoch = revision
      controller = new AbortController()
      try {
        // Metadata only: this route lists records already owned by the backend and starts no native work.
        const workspaces = await serverApi.fetchWorkspaces(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
        if (!current(epoch)) return
        if (!Array.isArray(workspaces)) throw new Error("Invalid workspace inventory")
        const exact = workspaces.find(workspace => workspace.id === source.instanceId)
        const matches = workspaces.filter(workspace => sameFolder(workspace.path))
        const workspace = exact ?? (matches.length === 1 ? matches[0] : undefined)
        boundId = workspace?.id
        if (!workspace || workspace.status !== "ready" || deleted.has(workspace.id)) { setResolved(undefined); return }
        const binding: ProjectContext = {
          instanceId: workspace.id,
          // A new backend record must not inherit an old native workspace selector.
          location: workspace.id === source.instanceId && source.location ? source.location : { directory: directory ?? workspace.path },
        }
        // Publishing the same context must not invalidate an in-flight provider catalog.
        const prior = untrack(resolved)?.context
        setResolved({ source: sourceKey, context: prior && key(prior) === key(binding) ? prior : binding })
        if (key(binding) !== sourceKey) {
          onRebound(binding, () => current(epoch) && untrack(context)?.instanceId === binding.instanceId)
        }
      } catch {
        // Startup/reconnect may still be restoring the project. Keep project controls inactive;
        // the next matching lifecycle event, reconnect or section opening revalidates it.
        if (current(epoch)) setResolved(undefined)
      }
    })
    const invalidate = (revoke = false) => {
      revision++
      if (revoke) setResolved(undefined)
      if (untrack(active)) scheduler.schedule("project", "urgent")
    }
    const events = serverEvents.on("*", event => {
      if (event.type === "workspace.created" || event.type === "workspace.started" || event.type === "workspace.error") {
        if (event.workspace.id === source.instanceId || event.workspace.id === boundId || !boundId && sameFolder(event.workspace.path)) {
          invalidate(event.workspace.status !== "ready")
        }
      } else if (event.type === "workspace.stopped"
        && (event.workspaceId === source.instanceId || event.workspaceId === boundId)) {
        if (event.reason === "deleted") { deleted.add(source.instanceId!); deleted.add(event.workspaceId) }
        invalidate(true)
      }
    })
    const reconnect = serverEvents.onOpen(() => invalidate(true))
    const transport = serverEvents.onTransportStatus(status => {
      if (status !== "disconnected") return
      revision++; setResolved(undefined); controller?.abort(); scheduler.cancel("project")
    })
    let initialDemand = true
    createEffect(() => {
      if (active()) {
        if (!initialDemand || !reusable) scheduler.schedule("project", "urgent")
      } else {
        revision++; setResolved(undefined); controller?.abort(); scheduler.cancel("project")
      }
      initialDemand = false
    })
    onCleanup(() => {
      disposed = true; controller?.abort(); scheduler.cancel("project")
      events(); reconnect(); transport()
    })
  })
  return context
}
