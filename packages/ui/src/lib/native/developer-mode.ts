import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isLocalWindow, isTauriHost } from "../runtime-env"

export type DeveloperModeState = {
  enabled: boolean
  active: boolean
}

export function supportsDeveloperMode(): boolean {
  return isLocalWindow() && (isElectronHost()
    || (isTauriHost() && typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)))
}

export async function getDeveloperMode(): Promise<DeveloperModeState> {
  if (!supportsDeveloperMode()) throw new Error("Developer mode is unavailable")

  if (isElectronHost()) {
    const get = window.electronAPI?.getDeveloperMode
    if (!get) throw new Error("Developer mode is unavailable")
    return get()
  }

  return invoke<DeveloperModeState>("developer_mode_get")
}

export async function setDeveloperMode(enabled: boolean): Promise<DeveloperModeState> {
  if (!supportsDeveloperMode()) throw new Error("Developer mode is unavailable")

  if (isElectronHost()) {
    const set = window.electronAPI?.setDeveloperMode
    if (!set) throw new Error("Developer mode is unavailable")
    return set(enabled)
  }

  return invoke<DeveloperModeState>("developer_mode_set", { enabled })
}
