import { invoke } from "@tauri-apps/api/core"
import { runtimeEnv } from "../runtime-env"

export type NativeWindowAction = "minimize" | "maximize" | "close"

export async function runNativeWindowAction(action: NativeWindowAction): Promise<void> {
  if (runtimeEnv.host === "electron") {
    const api = window.electronAPI
    const handler = action === "minimize" ? api?.minimizeWindow : action === "maximize" ? api?.toggleMaximizeWindow : api?.closeWindow
    if (!handler) throw new Error(`Native window action is unavailable: ${action}`)
    await handler()
    return
  }
  if (runtimeEnv.host === "tauri") {
    await invoke("window_control", { action })
  }
}

export async function startNativeWindowDrag(): Promise<void> {
  if (runtimeEnv.host === "tauri") await invoke("window_control", { action: "drag" })
}
