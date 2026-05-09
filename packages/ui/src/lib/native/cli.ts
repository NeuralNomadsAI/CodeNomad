import { invoke } from "@tauri-apps/api/core"
import { canRestartCli, isElectronHost, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"
const log = getLogger("actions")


export async function restartCli(): Promise<boolean> {
  if (!canRestartCli()) {
    return false
  }

  try {
    if (isElectronHost()) {
      const api = (window as typeof window & { electronAPI?: { restartCli?: () => Promise<unknown> } }).electronAPI
      if (api?.restartCli) {
        await api.restartCli()
        return true
      }
      return false
    }

    if (isTauriHost()) {
      if (typeof window.__TAURI__?.core?.invoke === "function") {
        await invoke("cli_restart")
        return true
      }
      return false
    }
  } catch (error) {
    log.error("Failed to restart CLI", error)
    return false
  }

  return false
}
