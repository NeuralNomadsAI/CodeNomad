import { invoke } from "@tauri-apps/api/core"
import { runtimeEnv } from "../runtime-env"

export type NativeWindowAction = "minimize" | "maximize" | "close"
export type NativeTitlebarMenu = "file" | "edit" | "view" | "window" | "help"

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

export async function showNativeTitlebarMenu(menu: NativeTitlebarMenu, element: HTMLElement): Promise<void> {
  const bounds = element.getBoundingClientRect()
  const position = { x: bounds.left, y: bounds.bottom }
  if (runtimeEnv.host === "electron") {
    if (!window.electronAPI?.showTitlebarMenu) throw new Error("Native titlebar menus are unavailable")
    await window.electronAPI.showTitlebarMenu(menu, position.x, position.y)
  } else if (runtimeEnv.host === "tauri") {
    await invoke("popup_titlebar_menu", { menu, ...position })
  }
}
