import { appTabs } from "./app-tabs"
import { backendIdOf } from "../lib/backend-identity"
import { RemoteServerInUseError } from "../lib/remote-server-request"
import { backendRegistry } from "./remote-backends"
import { remoteProjectHistory } from "./preferences"
import { tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"

export function confirmRemoteServerChange(id: string): Promise<boolean> {
  const tabs = appTabs()
  const live = tabs.find(tab => tab.kind === "instance" && backendIdOf(tab.instance) === id)
  if (live && backendRegistry.state(id) === "compatible") {
    throw new RemoteServerInUseError(tGlobal("remoteRestore.inUse"))
  }
  const saved = tabs.find(tab => tab.kind === "remote-restore" && backendIdOf(tab.snapshot) === id)
  const detail = live?.kind === "instance" ? live.instance.folder
    : saved?.kind === "remote-restore" ? saved.snapshot.folder
    : remoteProjectHistory().recents.find(recent => recent.policy.id === id)?.path
  return showConfirmDialog(tGlobal("remoteRestore.confirmChange"), { variant: "warning", detail })
}
