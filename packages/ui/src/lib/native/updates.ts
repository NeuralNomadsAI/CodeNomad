import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { isLocalWindow, isTauriHost } from "../runtime-env"

export type DesktopUpdateCheck =
  | { status: "unsupported" }
  | { status: "current" }
  | { status: "available"; version: string }

export function supportsDesktopUpdateChecks(): boolean {
  return isTauriHost() && isLocalWindow()
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateCheck> {
  if (!supportsDesktopUpdateChecks()) return { status: "unsupported" }
  return invoke<DesktopUpdateCheck>("check_stable_update")
}

export async function installDesktopUpdate(version: string): Promise<void> {
  if (!supportsDesktopUpdateChecks()) throw new Error("Native updates are unavailable in this window")
  await invoke("install_stable_update", { version })
}

export async function listenForDesktopUpdateFailure(callback: () => void): Promise<() => void> {
  if (!supportsDesktopUpdateChecks()) return () => {}
  return listen("desktop-update:failed", callback)
}
