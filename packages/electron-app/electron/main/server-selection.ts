import { normalizeServerSelection } from "../../../ui/src/lib/native/server-selection-intent"
import type { ServerSelectionIntent } from "../../../ui/src/lib/native/server-selection-intent"
import { withTimeout, type RendererFlushWindow } from "./renderer-client-state-flush"

export function requireServerSelection(value: unknown, section?: string): ServerSelectionIntent {
  const intent = normalizeServerSelection(value)
  if (!intent || section !== "servers") throw new Error("Invalid server selection")
  return intent
}

export async function selectServerInWindow(window: RendererFlushWindow | undefined, intent: ServerSelectionIntent, trusted: (url: string) => boolean): Promise<void> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Server selection opener unavailable")
  const url = window.webContents.getURL()
  if (!trusted(url)) throw new Error("Server selection opener untrusted")
  await withTimeout(window.webContents.executeJavaScript(`(() => {
    if (window.location.origin !== ${JSON.stringify(new URL(url).origin)}) throw new Error("Server selection origin changed");
    if (typeof window.__CODENOMAD_SELECT_SERVER__ !== "function") throw new Error("Server selection unavailable");
    window.__CODENOMAD_SELECT_SERVER__(${JSON.stringify(intent)});
  })()`), 5000, "Server selection")
}
