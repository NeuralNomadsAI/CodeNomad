import { For, Show, createEffect, createSignal } from "solid-js"
import { entries, paused, visible, clearLog, toggleVisibility, togglePause } from "../stores/debug-log"

export default function DebugOverlay() {
  let listRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!paused() && listRef) {
      queueMicrotask(() => {
        listRef?.scrollTo({ top: listRef.scrollHeight, behavior: "smooth" })
      })
    }
  })

  return (
    <>
      <button
        type="button"
        class="fixed bottom-3 right-3 z-[9999] w-8 h-8 rounded-full bg-surface-secondary border border-base shadow-lg flex items-center justify-center text-xs font-bold text-muted hover:text-primary select-none"
        onClick={toggleVisibility}
        title="Toggle debug log"
      >
        {visible() ? "✕" : "⚙"}
      </button>

      <Show when={visible()}>
        <div class="fixed bottom-14 right-3 z-[9999] w-[90vw] max-w-md h-80 bg-surface-secondary border border-base rounded-lg shadow-2xl flex flex-col overflow-hidden select-none">
          <div class="flex items-center justify-between px-3 py-1.5 border-b border-base bg-surface-tertiary text-[11px]">
            <span class="text-muted font-medium">Debug Log</span>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1 text-muted cursor-pointer">
                <input type="checkbox" checked={paused()} onChange={togglePause} class="w-3 h-3" />
                Pause
              </label>
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
