import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost } from "../runtime-env"

/** The host owns aggregation, image generation and window authorization. */
export async function setNativeNotificationBadge(count: number): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.setNotificationBadge?.(count)
  } else if (isTauriHost()) {
    await invoke("notification_badge_set", { count })
  }
}
