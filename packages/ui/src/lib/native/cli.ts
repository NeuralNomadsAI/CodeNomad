import { invoke } from "@tauri-apps/api/core"
import { runtimeEnv } from "../runtime-env"
import { getLogger } from "../logger"
const log = getLogger("actions")


export async function restartCli(): Promise<boolean> {
  try {
    if (runtimeEnv.host === "electron") {
      const api = (window as typeof window & { electronAPI?: { restartCli?: () => Promise<unknown> } }).electronAPI
      if (api?.restartCli) {
        await api.restartCli()
        return true
      }
      return false
    }

    if (runtimeEnv.host === "tauri") {
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
