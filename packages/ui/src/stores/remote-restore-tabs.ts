import { createSignal } from "solid-js"
import type { RestorableWorkspaceTabState } from "./client-state"

export interface RemoteRestoreTab {
  id: string
  kind: "remote-restore"
  snapshot: RestorableWorkspaceTabState
  instanceId?: string
  retry(): Promise<void>
  remove(): void
}

const [remoteRestoreTabs, setRemoteRestoreTabs] = createSignal<RemoteRestoreTab[]>([])
export { remoteRestoreTabs }
export function addRemoteRestoreTab(tab: RemoteRestoreTab) {
  setRemoteRestoreTabs(tabs => tabs.some(value => value.id === tab.id) ? tabs : [...tabs, tab])
}
export function removeRemoteRestoreTab(id: string) {
  setRemoteRestoreTabs(tabs => tabs.filter(tab => tab.id !== id))
}
