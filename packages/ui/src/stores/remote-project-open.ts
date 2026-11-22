import { normalizeServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { backendIdOf } from "../lib/backend-identity"
import type { BackendId } from "../lib/backend-transport"
import { backendRegistry } from "./remote-backends"
import { createInstance, instances, WorkspaceCreationDeparture, type WorkspaceCreationOwnership } from "./instances"
import { activeAppTabId, appTabs, getInstanceAppTabId, openBlankTab, selectAppTab, selectInstanceTab, type InstanceAppTab } from "./app-tabs"
import { workspaceIdentity } from "./app-session-reconciliation"
import type { RemoteRestoreTab } from "./remote-restore-tabs"
import { closeSettings } from "./settings-screen"
import { recordRemoteProjectLaunch, remoteRecentProjectsUsable, savedProjectProfile } from "./recent-projects"

export function selectRemoteServer(value: unknown): void {
  const intent = normalizeServerSelection(value)
  if (!intent || !savedProjectProfile(intent)) throw new Error("Server selection changed")
  closeSettings()
  openBlankTab(intent)
}

/** Matches visible tab membership, never unselected backend inventory records. */
export function findOpenProjectTab(path: string, backendId: BackendId): InstanceAppTab | RemoteRestoreTab | undefined {
  const identity = workspaceIdentity(path, backendId)
  const matches = appTabs().filter((tab): tab is InstanceAppTab | RemoteRestoreTab => {
    if (tab.kind === "blank" || tab.kind === "sidecar" || tab.kind === "instance" && tab.instance.status === "stopped") return false
    const project = tab.kind === "instance" ? tab.instance : tab.snapshot
    return backendIdOf(project) === backendId && workspaceIdentity(project.folder, backendId) === identity
  })
  return matches.find(tab => tab.id === activeAppTabId()) ?? matches.find(liveProjectTab) ?? matches.find(tab => tab.kind === "instance") ?? matches[0]
}

const liveProjectTab = (tab: InstanceAppTab | RemoteRestoreTab): tab is InstanceAppTab => tab.kind === "instance" && tab.instance.status !== "error"

/** Selects the folder's visible tab; only a live project counts as an opening in Recents. */
export function selectOpenProjectTab(intent: ServerSelectionIntent, path: string, projectName?: string): boolean {
  const tab = findOpenProjectTab(path, intent.id)
  if (!tab || selectAppTab(tab.id) !== true) return false
  if (liveProjectTab(tab)) recordRemoteProjectLaunch(intent, tab.instance.folder, path, projectName)
  return true
}

type OpenOptions = { projectName?: string; current?: () => boolean; onOpened?: (instanceId: string) => void }

/** Open with the caller's immutable policy and cancellation, without changing the server picker. */
export async function openRemoteProjectForProfile(profile: ServerSelectionIntent, path: string, signal: AbortSignal, options?: OpenOptions): Promise<boolean> {
  const { id, baseUrl, skipTlsVerify, ssh } = profile
  const intent = normalizeServerSelection({ id, baseUrl, skipTlsVerify, ssh })
  const current = () => !signal.aborted && remoteRecentProjectsUsable() && (options?.current?.() ?? true) && !!intent && !!savedProjectProfile(intent)
  if (!intent || !current() || !path.trim()) throw new Error("Server selection changed")
  let client = await backendRegistry.ensure(intent.id)
  if (!current()) return false
  // Opening is an explicit demand: recover one superseded/failed initial inventory.
  if (client && backendRegistry.state(intent.id) === "unreachable") client = await backendRegistry.retryWorkspaces(intent.id)
  if (!current()) return false
  if (!client || backendRegistry.state(intent.id) !== "compatible") throw new Error(backendRegistry.state(intent.id))
  let creation: WorkspaceCreationOwnership | undefined
  let transferred = false
  try {
    const result = await createInstance(path, options?.projectName, { backend: client, signal, onCreation: owner => { creation = owner } })
    if (!current() || !creation?.current(result.instanceId)) return false
    transferred = selectInstanceTab(result.instanceId, creation)
    if (!transferred) return false
    recordRemoteProjectLaunch(intent, instances().get(result.instanceId)?.folder ?? path, path, options?.projectName)
    if (activeAppTabId() === getInstanceAppTabId(result.instanceId)) options?.onOpened?.(result.instanceId)
    return true
  } catch (error) {
    if (error instanceof WorkspaceCreationDeparture) return false
    throw error
  } finally {
    if (!transferred) await creation?.discard()
  }
}
