import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { NativePreferencesRequest } from "../../lib/native/preferences-window"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { createEventRefreshScheduler } from "../../lib/event-refresh-scheduler"
import { isServerId, LOCAL_SERVER_ID, projectIdentity } from "../../lib/project-identity"
import type { WorkspaceDescriptor } from "../../../../server/src/api-types"

type ProjectContext = Pick<NativePreferencesRequest, "serverId" | "instanceId" | "workspacePath" | "location">
export type PreferencesProjectContext = ProjectContext & {
  readonly binding: Readonly<{ serverId: string; directory: string }>
  readonly capabilities: Readonly<NonNullable<WorkspaceDescriptor["capabilities"]>> | undefined
}
const key = (value: ProjectContext) => JSON.stringify([value.serverId ?? LOCAL_SERVER_ID, value.instanceId, value.workspacePath, value.location?.directory, value.location?.workspaceID])

/** Preferences is a secondary renderer: resolve only its requested project, without
 *  hydrating the application store, discovering worktrees or opening a workspace.
 *  Backend workspace IDs do not survive restart. An absent ID can be replaced by
 *  one unambiguous exact-folder match, never an ancestor or arbitrary other project. */
export function createPreferencesProjectContext(
  request: Accessor<NativePreferencesRequest>,
  active: Accessor<boolean>,
  onRebound: (context: ProjectContext, current: () => boolean) => void,
) {
  const target = createMemo(() => ({ serverId: request().serverId, instanceId: request().instanceId, workspacePath: request().workspacePath, location: request().location }), undefined,
    { equals: (a, b) => key(a) === key(b) })
  const [resolved, setResolved] = createSignal<{ source: string; context: PreferencesProjectContext }>()
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
    const serverId = source.serverId ?? LOCAL_SERVER_ID
    if (!isServerId(serverId)) return
    // The opened folder and selected Location can differ for WSL paths and worktrees.
    const workspacePath = source.workspacePath ?? directory
    const sameFolder = (path: string) => Boolean(workspacePath && projectIdentity(path, serverId) === projectIdentity(workspacePath, serverId))
    const matchesOpenedFolder = (workspace: WorkspaceDescriptor) => !source.workspacePath || sameFolder(workspace.path)
    const sameServer = (workspace: WorkspaceDescriptor) => (!workspace.binding || isServerId(workspace.binding.serverId))
      && (workspace.binding?.serverId ?? LOCAL_SERVER_ID) === serverId
      && (!workspace.binding || typeof workspace.binding.directory === "string" && projectIdentity(workspace.binding.directory, serverId) === projectIdentity(workspace.path, serverId))
    let disposed = false, connected = true, revision = 0, controller: AbortController | undefined, boundId = previous?.instanceId
    let candidateIds = new Set<string>()
    const current = (epoch: number) => !disposed && connected && untrack(active) && revision === epoch && !deleted.has(source.instanceId!)

    const scheduler = createEventRefreshScheduler(async () => {
      if (disposed || !connected || !untrack(active) || deleted.has(source.instanceId!)) return
      const epoch = revision
      controller = new AbortController()
      try {
        // Metadata only: this route lists records already owned by the backend and starts no native work.
        const workspaces = await serverApi.fetchWorkspaces(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
        if (!current(epoch)) return
        if (!Array.isArray(workspaces)) throw new Error("Invalid workspace inventory")
        const exact = workspaces.find(workspace => workspace.id === source.instanceId && sameServer(workspace) && matchesOpenedFolder(workspace))
        const matches = workspaces.filter(workspace => sameServer(workspace) && sameFolder(workspace.path) && !deleted.has(workspace.id))
        candidateIds = new Set(matches.map(workspace => workspace.id))
        const workspace = exact ?? (matches.length === 1 ? matches[0] : undefined)
        boundId = workspace?.id
        if (!workspace || workspace.status !== "ready" || deleted.has(workspace.id)) { setResolved(undefined); return }
        if (workspace.capabilities && (workspace.capabilities.serverId !== serverId || !Number.isSafeInteger(workspace.capabilities.generation) || workspace.capabilities.generation < 1)) {
          setResolved(undefined); return
        }
        const binding: ProjectContext = {
          ...(source.serverId !== undefined ? { serverId } : {}),
          instanceId: workspace.id,
          workspacePath: workspace.path,
          // A new backend record must not inherit an old native workspace selector.
          location: workspace.id === source.instanceId && source.location ? source.location : { directory: directory ?? workspace.path },
        }
        // Publishing the same context must not invalidate an in-flight provider catalog.
        const prior = untrack(resolved)?.context
        setResolved({ source: sourceKey, context: prior && key(prior) === key(binding) && JSON.stringify(prior.capabilities) === JSON.stringify(workspace.capabilities) ? prior : {
          ...binding, binding: { serverId, directory: workspace.binding?.directory ?? workspace.path }, capabilities: workspace.capabilities,
        } })
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
      if (event.type === "instance.eventStatus" && (event.instanceId === source.instanceId || event.instanceId === boundId)) {
        connected = event.status === "connected" && (serverId === LOCAL_SERVER_ID || event.source?.serverId === serverId)
        revision++; controller?.abort(); scheduler.cancel("project"); setResolved(undefined)
        if (connected && untrack(active)) scheduler.schedule("project", "urgent")
      } else if (event.type === "workspace.created" || event.type === "workspace.started" || event.type === "workspace.error") {
        if (event.workspace.id === source.instanceId || event.workspace.id === boundId || sameServer(event.workspace) && !boundId && sameFolder(event.workspace.path)) {
          invalidate(!sameServer(event.workspace) || !matchesOpenedFolder(event.workspace) || event.workspace.status !== "ready"
            || JSON.stringify(event.workspace.capabilities) !== JSON.stringify(untrack(context)?.capabilities))
        }
      } else if (event.type === "workspace.stopped") {
        // A deletion can arrive before the first inventory response reveals its candidate IDs.
        if (event.reason === "deleted") deleted.add(event.workspaceId)
        if (event.workspaceId === source.instanceId || event.workspaceId === boundId) {
          if (event.reason === "deleted") deleted.add(source.instanceId!)
          invalidate(true)
        } else if (candidateIds.has(event.workspaceId)) invalidate()
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
