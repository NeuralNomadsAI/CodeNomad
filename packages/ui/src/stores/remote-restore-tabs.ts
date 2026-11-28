import { createSignal } from "solid-js"
import type { RestorableWorkspaceTabState } from "./client-state"
import { retainClosedWorkspaceSnapshot } from "./closed-workspace-drafts"

export interface RemoteRestoreTab {
  id: string
  kind: "remote-restore"
  snapshot: RestorableWorkspaceTabState
  instanceId?: string
  retry(): Promise<void>
  remove(options?: { retainWorkspace?: boolean }): void
}

const [remoteRestoreTabs, setRemoteRestoreTabs] = createSignal<RemoteRestoreTab[]>([])
export { remoteRestoreTabs }
export function addRemoteRestoreTab(tab: RemoteRestoreTab) {
  const owned: RemoteRestoreTab = {
    ...tab,
    remove(options) {
      if (!remoteRestoreTabs().includes(owned)) return
      retainClosedWorkspaceSnapshot(tab.snapshot)
      tab.remove(options)
    },
  }
  setRemoteRestoreTabs(tabs => tabs.some(value => value.id === tab.id) ? tabs : [...tabs, owned])
}
export function removeRemoteRestoreTab(id: string) {
  setRemoteRestoreTabs(tabs => tabs.filter(tab => tab.id !== id))
}
