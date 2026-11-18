import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { isElectronHost, isTauriHost, isLocalWindow, isPreferencesWindow } from "../runtime-env"
import { normalizeMemoryCleanupRequest, type MemoryCleanupRequest } from "./memory-cleanup-command"

export async function requestMemoryCleanup(request: MemoryCleanupRequest): Promise<void> {
  if (!normalizeMemoryCleanupRequest(request)) throw new Error("Invalid memory cleanup request")
  if (isPreferencesWindow() && isElectronHost()) {
    if (!window.electronAPI?.memoryCleanup) throw new Error("Memory cleanup unavailable")
    await window.electronAPI.memoryCleanup(request)
  } else if (isPreferencesWindow() && isTauriHost()) {
    await invoke("preferences_memory_cleanup", { request })
  } else {
    const { runMemoryCleanup } = await import("../../stores/agent-memory-cleanup")
    await runMemoryCleanup(request)
    const { closeSettings } = await import("../../stores/settings-screen")
    closeSettings()
  }
}

export async function installMemoryCleanupHandler(run: (request: MemoryCleanupRequest) => Promise<void>): Promise<void> {
  if (!isLocalWindow()) return
  const handle = (value: unknown) => {
    const request = normalizeMemoryCleanupRequest(value)
    if (!request) return Promise.reject(new Error("Invalid memory cleanup request"))
    return run(request)
  }
  window.__CODENOMAD_MEMORY_CLEANUP__ = handle
  if (isTauriHost()) await listen<{ windowId: string; request: unknown }>("memory:cleanup", ({ payload }) => {
    if (payload?.windowId !== window.__CODENOMAD_WINDOW_ID__) return
    const hint = normalizeMemoryCleanupRequest(payload.request)
    if (!hint) return
    // Events are hints: only the native host can authorize a pending intent for this renderer.
    void invoke<unknown>("memory_cleanup_claim", { id: hint.id }).then(async value => {
      const request = normalizeMemoryCleanupRequest(value)
      if (!request) return
      const ok = await handle(request).then(() => true, () => false)
      await invoke("memory_cleanup_result", { id: request.id, ok })
    }).catch(() => undefined)
  })
}
