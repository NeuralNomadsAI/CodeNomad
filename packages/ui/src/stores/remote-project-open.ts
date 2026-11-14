import { createSignal } from "solid-js"
import { normalizeServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { preferences, preferencesForBackend } from "./preferences"
import { backendRegistry } from "./remote-backends"
import { createInstance, type WorkspaceCreationOwnership } from "./instances"
import { appTabs, selectAppTab, selectInstanceTab } from "./app-tabs"
import { workspaceIdentity } from "./app-session-reconciliation"
import { closeSettings } from "./settings-screen"

const [selection, setSelection] = createSignal<ServerSelectionIntent>()
const remoteServers = () => preferencesForBackend("local").remoteServers()
export const remoteServerSelection = selection
export function selectedRemoteProfile(intent = selection()) {
  return preferences().multiBackend === true && intent
    ? remoteServers().find(p => p.id === intent.id && p.baseUrl === intent.baseUrl
      && p.skipTlsVerify === intent.skipTlsVerify && p.ssh?.host === intent.ssh?.host) : undefined
}
export function selectRemoteServer(value: unknown): void {
  const intent = normalizeServerSelection(value)
  if (!intent || !selectedRemoteProfile(intent)) throw new Error("Server selection changed")
  // Same-policy reselection keeps the mounted browser's opening authority.
  if (selectedRemoteProfile() !== selectedRemoteProfile(intent)) setSelection(intent)
  closeSettings()
}
export const closeRemoteServer = () => setSelection(undefined)

/** Caller cancellation belongs only to this opening, never another occurrence. */
export async function openRemoteProject(path: string, signal: AbortSignal): Promise<boolean> {
  const intent = selection()
  const current = () => !signal.aborted && selection() === intent && !!selectedRemoteProfile(intent)
  if (!current() || !intent || !path.trim()) throw new Error("Server selection changed")
  const selectWaiting = () => {
    const waiting = appTabs().find(tab => tab.kind === "remote-restore"
      && workspaceIdentity(tab.snapshot.folder, tab.snapshot.backendId) === workspaceIdentity(path, intent.id))
    if (!waiting) return false
    selectAppTab(waiting.id)
    if (current()) closeRemoteServer()
    return true
  }
  if (selectWaiting()) return true
  let client = await backendRegistry.ensure(intent.id)
  if (!current()) return false
  // Opening is an explicit demand: recover one superseded/failed initial inventory.
  if (client && backendRegistry.state(intent.id) === "unreachable") client = await backendRegistry.retryWorkspaces(intent.id)
  if (!current()) return false
  if (selectWaiting()) return true
  if (!client || backendRegistry.state(intent.id) !== "compatible") throw new Error(backendRegistry.state(intent.id))
  let creation: WorkspaceCreationOwnership | undefined
  let transferred = false
  try {
    const result = await createInstance(path, undefined, { backend: client, signal, onCreation: owner => { creation = owner } })
    if (!current() || !creation?.current(result.instanceId)) return false
    transferred = selectInstanceTab(result.instanceId, creation)
    if (!transferred) return false
    if (current()) closeRemoteServer()
    return true
  } finally {
    if (!transferred) await creation?.discard()
  }
}
