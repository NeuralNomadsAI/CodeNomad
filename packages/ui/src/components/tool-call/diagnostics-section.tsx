import { For, Show } from "solid-js"
import type { DiagnosticEntry } from "./diagnostics"

export function renderDiagnosticsSection(
  entries: DiagnosticEntry[],
  expanded: boolean,
  toggle: () => void,
  fileLabel: string,
) {
  if (entries.length === 0) return null
  return (
    <div class="tool-call-diagnostics-wrapper">
      <button
        type="button"
        class="tool-call-diagnostics-heading"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span class="tool-call-icon" aria-hidden="true">
          {expanded ? "▼" : "▶"}
        </span>
        <span class="tool-call-emoji" aria-hidden="true">
          🛠
        </span>
        <span class="tool-call-summary">Diagnostics</span>
        <span class="tool-call-diagnostics-file" title={fileLabel}>
          {fileLabel}
        </span>
      </button>
      <Show when={expanded}>
        <div class="tool-call-diagnostics" role="region" aria-label="Diagnostics">
          <div class="tool-call-diagnostics-body" role="list">
            <For each={entries}>
              {(entry) => (
                <div class="tool-call-diagnostic-row" role="listitem">
                  <span class={`tool-call-diagnostic-chip tool-call-diagnostic-${entry.tone}`}>
                    <span class="tool-call-diagnostic-chip-icon">{entry.icon}</span>
                    <span>{entry.label}</span>
                  </span>
                  <span class="tool-call-diagnostic-path" title={entry.filePath}>
                    {entry.displayPath}
                    <span class="tool-call-diagnostic-coords">:L{entry.line || "-"}:C{entry.column || "-"}</span>
                  </span>
                  <span class="tool-call-diagnostic-message">{entry.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
