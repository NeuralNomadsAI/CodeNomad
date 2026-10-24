import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { UpdateFeed } from "../../../../server/src/api-types"
import { isNativeApplicationWindow, isTauriHost } from "../runtime-env"

export type DesktopUpdateCheck =
  | { status: "unsupported" }
  | { status: "current" }
  | { status: "available"; version: string }
  | { status: "busy" }

/** Application windows and the Preferences window run updates; remote windows do not. */
export function supportsDesktopUpdateChecks(): boolean {
  return isTauriHost() && isNativeApplicationWindow()
}

/** Without a saved feed the native host derives it from the installed build. */
export async function checkDesktopUpdate(feed: UpdateFeed | undefined): Promise<DesktopUpdateCheck> {
  if (!supportsDesktopUpdateChecks()) return { status: "unsupported" }
  return invoke<DesktopUpdateCheck>("check_desktop_update", { feed })
}

export async function installDesktopUpdate(version: string): Promise<void> {
  if (!supportsDesktopUpdateChecks()) throw new Error("Native updates are unavailable in this window")
  await invoke("install_desktop_update", { version })
}

/** Returns and clears a failure recorded while windows were reloading. */
export async function takeDesktopUpdateFailure(): Promise<boolean> {
  if (!supportsDesktopUpdateChecks()) return false
  return invoke<boolean>("take_desktop_update_failure")
}

export async function listenForDesktopUpdateFailure(callback: () => void): Promise<() => void> {
  if (!supportsDesktopUpdateChecks()) return () => {}
  return listen("desktop-update:failed", callback)
}
