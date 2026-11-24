import { getCurrentWebview } from "@tauri-apps/api/webview"
import { isLocalWindow, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"

// One window-owned listener; never subscribe to untargeted native events.
export function listenMenuActions(handle: (action: unknown) => void): () => void {
  if (!isTauriHost()) return window.electronAPI?.onMenuAction?.(handle) ?? (() => {})
  if (!isLocalWindow()) return () => {}
  let disposed = false, remove: (() => void) | undefined
  getCurrentWebview().listen("menu:action", (event) => handle(event.payload)).then((unlisten) => {
    if (disposed) unlisten()
    else remove = unlisten
  }).catch((error) => getLogger("actions").error("Failed to listen for native menu actions", error))
  return () => { disposed = true; remove?.() }
}
