import { createSignal, Show, type Component } from "solid-js"
import { Activity } from "lucide-solid"

export const DevSettingsSection: Component = () => {
  const [gcResult, setGcResult] = createSignal<string | null>(null)
  const [snapshotResult, setSnapshotResult] = createSignal<string | null>(null)

  const handleForceGC = async () => {
    const api = window.electronAPI
    if (typeof api?.forceGC !== "function") {
      setGcResult("forceGC not available — start with CODENOMAD_DIAG=1")
      return
    }
    try {
      await api.forceGC()
      setGcResult(`GC triggered at ${new Date().toLocaleTimeString()}`)
    } catch (err) {
      setGcResult(`Error: ${String(err)}`)
    }
  }

  const handleMemorySnapshot = async () => {
    const api = window.electronAPI
    if (typeof api?.getMemorySnapshot !== "function") {
      setSnapshotResult("getMemorySnapshot not available — start with CODENOMAD_DIAG=1")
      return
    }
    try {
      const snapshot = await api.getMemorySnapshot()
      const mem = snapshot.mainMemory
      const toMB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`
      setSnapshotResult(
        `rss=${toMB(mem.rss)} heap=${toMB(mem.heapUsed)}/${toMB(mem.heapTotal)} ext=${toMB(mem.external)}`,
      )
    } catch (err) {
      setSnapshotResult(`Error: ${String(err)}`)
    }
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Activity class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">Developer Diagnostics</h3>
              <p class="settings-card-subtitle">
                Memory profiling tools. Run with <code>CODENOMAD_DIAG=1</code> to enable IPC handlers.
              </p>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", padding: "0 16px 16px" }}>
          <button type="button" class="btn btn-secondary" onClick={handleForceGC}>
            Force GC
          </button>
          <button type="button" class="btn btn-secondary" onClick={handleMemorySnapshot}>
            Memory Snapshot
          </button>
        </div>

        <Show when={gcResult()}>
          <p style={{ padding: "0 16px 8px", "font-size": "12px", "font-family": "monospace" }}>{gcResult()}</p>
        </Show>
        <Show when={snapshotResult()}>
          <p style={{ padding: "0 16px 8px", "font-size": "12px", "font-family": "monospace" }}>{snapshotResult()}</p>
        </Show>
      </div>
    </div>
  )
}
