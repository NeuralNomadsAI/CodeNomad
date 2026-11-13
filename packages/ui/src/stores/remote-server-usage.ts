import { appTabs } from "./app-tabs"
import { loadedRestorableSession } from "./client-state"
import { backendIdOf } from "../lib/backend-identity"
import { backendRegistry } from "./remote-backends"
import { tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"

/** Fail closed when another window's inventory cannot be checked. */
export async function confirmRemoteServerChange(id: string): Promise<boolean> {
  const inUse = () => appTabs().some(tab => tab.kind === "instance" && backendIdOf(tab.instance) === id
    || tab.kind === "remote-restore" && backendIdOf(tab.snapshot) === id)
    || loadedRestorableSession()?.tabs.some(tab => tab.kind === "workspace" && backendIdOf(tab) === id)
  const refuse = () => { throw new Error(tGlobal("remoteRestore.inUse")) }
  if (inUse()) refuse()
  const backend = await backendRegistry.ensure(id)
  if (!backend) refuse()
  try {
    if ((await backend!.api.fetchWorkspaces()).length || inUse()) refuse()
  } catch { refuse() }
  return showConfirmDialog(tGlobal("remoteRestore.confirmChange"), { variant: "warning" })
}
