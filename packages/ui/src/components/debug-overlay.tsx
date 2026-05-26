import { For, Show, createEffect, createSignal } from "solid-js"
import { entries, paused, visible, clearLog, toggleVisibility, togglePause, exportLog } from "../stores/debug-log"
import { serverEvents } from "../lib/server-events"
import { CODENOMAD_API_BASE } from "../lib/api-client"

export default function DebugOverlay() {
  let listRef: HTMLDivElement | undefined
  const [sending, setSending] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  createEffect(() => {
    if (!paused() && listRef) {
      queueMicrotask(() => {
        listRef?.scrollTo({ top: listRef.scrollHeight, behavior: "smooth" })
      })
    }
  })

  async function copyLog() {
    try {
      const text = entries().map((e) => `[${e.ts}] ${e.level.toUpperCase()} ${e.source}: ${e.message}`).join("\n")
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback for insecure contexts
    }
  }

  async function sendToServer() {
    setSending(true)
    try {
      const data = entries()
      await fetch(`${CODENOMAD_API_BASE || ""}/api/debug-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logs: data }),
      })
    } catch {
      // Silently fail — the user can use export instead
    } finally {
      setSending(false)
    }
  }

  function downloadLog() {
    const blob = new Blob([exportLog()], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `codenomad-debug-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Show when={visible()}>
        <div class="fixed bottom-14 right-3 z-[9999] w-[90vw] max-w-md h-96 bg-surface-secondary border border-base rounded-lg shadow-2xl flex flex-col overflow-hidden select-none">
          <div class="flex items-center justify-between px-3 py-1.5 border-b border-base bg-surface-tertiary text-[11px]">
            <span class="text-muted font-medium">Debug Log ({entries().length}){serverEvents.connected ? "" : " ⚠ disconnected"}</span>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1 text-muted cursor-pointer">
                <input type="checkbox" checked={paused()} onChange={togglePause} class="w-3 h-3" />
                Pause
              </label>
              <button type="button" class="text-muted hover:text-primary" onClick={copyLog} title="Copy to clipboard">{copied() ? "Copied!" : "Copy"}</button>
              <button type="button" class="text-muted hover:text-primary" onClick={downloadLog} title="Download as JSON">Export</button>
              <button type="button" class="text-muted hover:text-primary" onClick={sendToServer} disabled={sending()}>
                {sending() ? "..." : "Send"}
              </button>
              <button type="button" class="text-muted hover:text-primary" onClick={clearLog}>Clear</button>
              <button type="button" class="text-muted hover:text-primary" onClick={toggleVisibility}>Close</button>
            </div>
          </div>
          <div ref={listRef} class="flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed space-y-0.5">
            <For each={entries()}>
              {(entry) => (
                <div
                  class={`truncate ${
                    entry.level === "error"
                      ? "text-red-400"
                      : entry.level === "warn"
                        ? "text-amber-400"
                        : entry.level === "debug"
                          ? "text-muted"
                          : "text-secondary"
                  }`}
                >
                  <span class="text-muted">[{entry.ts}]</span>
                  {" "}
                  <span class={
                    entry.level === "error"
                      ? "text-red-400"
                      : entry.level === "warn"
                        ? "text-amber-400"
                        : "text-muted"
                  }>
                    {entry.level.toUpperCase()}
                  </span>
                  {" "}
                  <span class="text-muted">{entry.source}:</span>
                  {" "}
                  <span>{entry.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  )
}
