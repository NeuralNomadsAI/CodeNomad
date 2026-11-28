import { normalizeMemoryCleanupRequest, type MemoryCleanupRequest } from "../../../ui/src/lib/native/memory-cleanup-command"
import type { PreferencesRequest } from "./preferences-window"
import { withTimeout, type RendererFlushWindow } from "./renderer-client-state-flush"

export function requireMemoryCleanup(value: unknown, context: PreferencesRequest | undefined): MemoryCleanupRequest {
  const request = normalizeMemoryCleanupRequest(value)
  if (!request || context?.section !== "general" || context.instanceId !== request.workspaceId ||
      context.serverId !== request.serverId || context.location?.directory !== request.directory) throw new Error("Memory cleanup context changed")
  return request
}

export async function runMemoryCleanupInWindow(window: RendererFlushWindow | undefined, request: MemoryCleanupRequest, trusted: (url: string) => boolean): Promise<void> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Cleanup opener unavailable")
  const url = window.webContents.getURL()
  if (!trusted(url)) throw new Error("Cleanup opener untrusted")
  await withTimeout(window.webContents.executeJavaScript(`(() => {
    if (window.location.origin !== ${JSON.stringify(new URL(url).origin)}) throw new Error("Cleanup origin changed");
    const run = window.__CODENOMAD_MEMORY_CLEANUP__;
    if (typeof run !== "function") throw new Error("Cleanup opener unavailable");
    return run(${JSON.stringify(request)});
  })()`), 30_000, "Memory cleanup")
}
