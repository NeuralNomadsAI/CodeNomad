import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { NativePreferencesRequest } from "../../lib/native/preferences-window"
import { backendOf } from "../../lib/backend-client"
import { instanceKey, parseInstanceKey } from "../../lib/backend-identity"
import { backendRegistry } from "../../stores/remote-backends"
import { captureBackendOperation } from "../../lib/backend-operation"
import { backendEvents as serverEvents } from "../../lib/server-events"
import { createEventRefreshScheduler } from "../../lib/event-refresh-scheduler"
import { normalizeWorkspacePath } from "../../stores/app-session-reconciliation"

type ProjectContext = Pick<NativePreferencesRequest, "instanceId" | "serverId" | "workspacePath" | "location">
const key = (value: ProjectContext) => JSON.stringify([value.instanceId, value.serverId, value.workspacePath, value.location?.directory, value.location?.workspaceID])

/** Preferences is a secondary renderer: resolve only its requested project, without
 *  hydrating the application store, discovering worktrees or opening a workspace.
 *  Backend workspace IDs do not survive restart. An absent ID can be replaced by
 *  one unambiguous exact-folder match, never an ancestor or arbitrary other project. */
export function createPreferencesProjectContext(
  request: Accessor<NativePreferencesRequest>,
  active: Accessor<boolean>,
  onRebound: (context: ProjectContext, current: () => boolean) => void,
) {
  const target = createMemo(() => ({ instanceId: request().instanceId, serverId: request().serverId, workspacePath: request().workspacePath, location: request().location }), undefined,
    { equals: (a, b) => key(a) === key(b) })
  const [resolved, setResolved] = createSignal<{ source: string; context: ProjectContext }>()
  const [failedSource, setFailedSource] = createSignal<string>()
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
    setFailedSource(undefined)
    if (!source.instanceId) return
    const unavailable = () => { setResolved(undefined); setFailedSource(sourceKey) }
    const { backendId, workspaceId } = parseInstanceKey(source.instanceId)
    if (backendId === "local" && source.instanceId.includes("~")) { unavailable(); return }
    if (backendId !== "local" && !source.serverId) { unavailable(); return }
    const attachment = serverEvents.signalForInstance(source.instanceId)
    if (attachment.aborted) {
      setResolved(undefined)
      if (backendId !== "local" && active()) {
        let disposed = false
        onCleanup(() => { disposed = true })
        void backendRegistry.ensure(backendId).then(client => { if (!disposed && !client) unavailable() })
      } else unavailable()
      return
    }
    if (backendId !== "local" && backendRegistry.serverId(backendId) !== source.serverId) { unavailable(); return }
    const api = backendOf(source.instanceId).api
    const scoped = (id: string) => instanceKey(backendId, id)
    const directory = source.location?.directory
    // The opened folder is on the backend host; the selected Location may be a WSL path or a worktree.
    const workspacePath = source.workspacePath ?? directory
    const sameFolder = (path: string) => Boolean(workspacePath && normalizeWorkspacePath(path) === normalizeWorkspacePath(workspacePath))
    let disposed = false, revision = 0, controller: AbortController | undefined, boundId = previous?.instanceId
    const operation = captureBackendOperation(source.instanceId, undefined, () => !disposed)
    let candidateIds = new Set<string>()
    const current = (epoch: number) => operation.current() && untrack(active) && revision === epoch && !deleted.has(source.instanceId!)

    const scheduler = createEventRefreshScheduler(async () => {
      if (!operation.current() || !untrack(active) || deleted.has(source.instanceId!)) return
      const epoch = revision
      controller = new AbortController()
      try {
        // Metadata only: this route lists records already owned by the backend and starts no native work.
        const workspaces = await api.fetchWorkspaces(AbortSignal.any([controller.signal, operation.signal, AbortSignal.timeout(10_000)]))
        if (!current(epoch)) return
        if (!Array.isArray(workspaces)) throw new Error("Invalid workspace inventory")
        const exact = workspaces.find(workspace => workspace.id === workspaceId && (!source.workspacePath || sameFolder(workspace.path)))
        const matches = workspaces.filter(workspace => sameFolder(workspace.path) && !deleted.has(scoped(workspace.id)))
        candidateIds = new Set(matches.map(workspace => scoped(workspace.id)))
        const workspace = exact ?? (matches.length === 1 ? matches[0] : undefined)
        boundId = workspace && scoped(workspace.id)
        if (!workspace || workspace.status !== "ready" || deleted.has(scoped(workspace.id))) { unavailable(); return }
        const binding: ProjectContext = {
          instanceId: scoped(workspace.id),
          ...(source.serverId ? { serverId: source.serverId } : {}),
          workspacePath: workspace.path,
          // A new backend record must not inherit an old native workspace selector.
          location: workspace.id === workspaceId && source.location ? source.location : { directory: directory ?? workspace.path },
        }
        // Publishing the same context must not invalidate an in-flight provider catalog.
        const prior = untrack(resolved)?.context
        setResolved({ source: sourceKey, context: prior && key(prior) === key(binding) ? prior : binding })
        setFailedSource(undefined)
        if (key(binding) !== sourceKey) {
          onRebound(binding, () => current(epoch) && untrack(context)?.instanceId === binding.instanceId)
        }
      } catch {
        // Startup/reconnect may still be restoring the project. Keep project controls inactive;
        // the next matching lifecycle event, reconnect or section opening revalidates it.
        if (current(epoch)) unavailable()
      }
    })
    const invalidate = (revoke = false) => {
      revision++
      if (revoke) setResolved(undefined)
      if (untrack(active) && !deleted.has(source.instanceId!)) {
        setFailedSource(undefined)
        scheduler.schedule("project", "urgent")
      }
    }
    const events = serverEvents.forInstance(() => source.instanceId).on("*", event => {
      if (event.type === "workspace.created" || event.type === "workspace.started" || event.type === "workspace.error") {
        if (event.workspace.id === source.instanceId || event.workspace.id === boundId || !boundId && sameFolder(event.workspace.path)) {
          invalidate(event.workspace.status !== "ready")
        }
      } else if (event.type === "workspace.stopped") {
        // A deletion can arrive before the first inventory response reveals its candidate IDs.
        if (event.reason === "deleted") deleted.add(event.workspaceId)
        if (event.workspaceId === source.instanceId || event.workspaceId === boundId) {
          if (event.reason === "deleted") { deleted.add(source.instanceId!); unavailable() }
          invalidate(true)
        } else if (candidateIds.has(event.workspaceId)) invalidate()
      }
    })
    const reconnect = serverEvents.forInstance(() => source.instanceId).onOpen(() => invalidate(true))
    const transport = serverEvents.forInstance(() => source.instanceId).onTransportStatus(status => {
      if (status !== "disconnected") return
      revision++; unavailable(); controller?.abort(); scheduler.cancel("project")
    })
    let initialDemand = true
    createEffect(() => {
      if (active()) {
        if ((!initialDemand || !reusable) && !deleted.has(source.instanceId!)) {
          setFailedSource(undefined)
          scheduler.schedule("project", "urgent")
        }
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
  return { context, unavailable: () => active() && failedSource() === key(target()) }
}
