import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost } from "../runtime-env"

let pending: Promise<void> = Promise.resolve()

/** The host owns aggregation, image generation and window authorization. */
export function setNativeNotificationBadge(count: number): Promise<void> {
  // Keep async Tauri commands in send order, including the final cleanup count.
  pending = pending.catch(() => {}).then(async () => {
    if (isElectronHost()) {
      await window.electronAPI?.setNotificationBadge?.(count)
    } else if (isTauriHost()) {
      await invoke("notification_badge_set", { count })
    }
  })
  return pending
}
