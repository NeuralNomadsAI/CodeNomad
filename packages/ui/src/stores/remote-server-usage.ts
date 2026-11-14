import { appTabs } from "./app-tabs"
import { loadedRestorableSession } from "./client-state"
import { backendIdOf, parseInstanceKey } from "../lib/backend-identity"
import { isPreferencesWindow } from "../lib/runtime-env"
import { getNativePreferencesRequest } from "../lib/native/preferences-window"
import { backendRegistry } from "./remote-backends"
import { tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"

/** Fail closed when another window's inventory cannot be checked. */
export async function confirmRemoteServerChange(id: string): Promise<boolean> {
  const inUse = async () => appTabs().some(tab => tab.kind === "instance" && backendIdOf(tab.instance) === id
    || tab.kind === "remote-restore" && backendIdOf(tab.snapshot) === id)
    || loadedRestorableSession()?.tabs.some(tab => tab.kind === "workspace" && backendIdOf(tab) === id)
    || isPreferencesWindow() && parseInstanceKey((await getNativePreferencesRequest()).instanceId ?? "").backendId === id
  const refuse = () => { throw new Error(tGlobal("remoteRestore.inUse")) }
  try {
    if (await inUse()) refuse()
    const backend = await backendRegistry.ensure(id)
    if (!backend || (await backend.api.fetchWorkspaces()).length || await inUse()) refuse()
  } catch { refuse() }
  return showConfirmDialog(tGlobal("remoteRestore.confirmChange"), { variant: "warning" })
}
