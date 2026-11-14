import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isPreferencesWindow, isTauriHost } from "../runtime-env"
import { normalizeServerSelection, type ServerSelectionIntent } from "./server-selection-intent"

export async function requestServerSelection(intent: ServerSelectionIntent): Promise<void> {
  const target = normalizeServerSelection(intent)
  if (!target) throw new Error("Invalid server selection")
  if (isPreferencesWindow() && isElectronHost()) {
    if (!window.electronAPI?.selectServer) throw new Error("Server selection unavailable")
    await window.electronAPI.selectServer(target)
  } else if (isPreferencesWindow() && isTauriHost()) {
    await invoke("preferences_select_server", { intent: target })
  } else {
    const { selectRemoteServer } = await import("../../stores/remote-project-open")
    selectRemoteServer(target)
  }
}
