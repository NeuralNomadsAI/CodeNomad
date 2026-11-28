import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isPreferencesWindow, isTauriHost } from "../runtime-env"
import { normalizeServerSelection, type ServerSelectionIntent } from "./server-selection-intent"

export async function requestServerSelection(intent: ServerSelectionIntent): Promise<void> {
  await requestServerAction(intent, "open")
}

export async function requestServerRemoval(intent: ServerSelectionIntent, current?: () => boolean, signal?: AbortSignal): Promise<void> {
  if (current && !current()) return
  await requestServerAction(intent, "remove", current, signal)
}

async function requestServerAction(intent: ServerSelectionIntent, action: "open" | "remove", current?: () => boolean, signal?: AbortSignal) {
  const { id, baseUrl, skipTlsVerify, ssh } = intent
  const target = normalizeServerSelection({ id, baseUrl, skipTlsVerify, ssh })
  if (!target) throw new Error("Invalid server selection")
  if (isPreferencesWindow() && isElectronHost()) {
    if (!window.electronAPI?.selectServer) throw new Error("Server selection unavailable")
    if (action === "remove") await window.electronAPI.selectServer(target, action)
    else await window.electronAPI.selectServer(target)
  } else if (isPreferencesWindow() && isTauriHost()) {
    await invoke("preferences_select_server", { intent: target, ...(action === "remove" ? { action } : {}) })
  } else if (action === "remove") {
    const { preferencesForBackend } = await import("../../stores/preferences")
    await preferencesForBackend("local").removeRemoteServerProfile(target.id, current, signal)
  } else {
    const { selectRemoteServer } = await import("../../stores/remote-project-open")
    selectRemoteServer(target)
  }
}
