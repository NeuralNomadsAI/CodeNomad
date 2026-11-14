import { appTabs } from "./app-tabs"
import { loadedRestorableSession } from "./client-state"
import { backendIdOf, parseInstanceKey } from "../lib/backend-identity"
import { isPreferencesWindow } from "../lib/runtime-env"
import { getNativePreferencesRequest } from "../lib/native/preferences-window"
import { RemoteServerInUseError } from "../lib/remote-server-request"
import { backendRegistry } from "./remote-backends"
import { tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"

/** Fail closed when another window's inventory cannot be checked. */
export async function confirmRemoteServerChange(id: string): Promise<boolean> {
  const inUse = async () => appTabs().some(tab => tab.kind === "instance" && backendIdOf(tab.instance) === id
    || tab.kind === "remote-restore" && backendIdOf(tab.snapshot) === id)
    || loadedRestorableSession()?.tabs.some(tab => tab.kind === "workspace" && backendIdOf(tab) === id)
    || isPreferencesWindow() && parseInstanceKey((await getNativePreferencesRequest()).instanceId ?? "").backendId === id
  const refuse = () => { throw new RemoteServerInUseError(tGlobal("remoteRestore.inUse")) }
  const unavailable = () => new Error(tGlobal("settings.preferenceSaveFailed"))
  try {
    if (await inUse()) refuse()
    const backend = await backendRegistry.ensure(id)
    if (!backend) throw unavailable()
    const workspaces = await backend.api.fetchWorkspaces()
    if (!Array.isArray(workspaces)) throw unavailable()
    if (workspaces.length || await inUse()) refuse()
  } catch (error) {
    throw error instanceof RemoteServerInUseError ? error : unavailable()
  }
  return showConfirmDialog(tGlobal("remoteRestore.confirmChange"), { variant: "warning" })
}
