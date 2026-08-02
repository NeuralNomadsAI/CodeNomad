import { For, Show } from "solid-js"
import { Copy } from "lucide-solid"
import { hasDiagnosticMessages, type DiagnosticsMap, type DiagnosticsView } from "./diagnostics"
import { copyToClipboard } from "../../lib/clipboard"
import { formatUnknownForCopy } from "./utils"

export function DiagnosticsPayloadAccess(props: {
  diagnostics: DiagnosticsMap
  truncated: boolean
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  return (
    <div class="tool-call-diagnostic-row">
      <span class="tool-call-diagnostic-message">
        {props.t(props.truncated ? "toolCall.output.truncated" : "toolCall.diagnostics.title")}
      </span>
      <button
        type="button"
        class="tool-call-header-icon-button tool-call-header-copy"
        onClick={() => void copyToClipboard(formatUnknownForCopy(props.diagnostics)?.text ?? "")}
        aria-label={props.t("toolCall.io.copyOutputAriaLabel")}
        title={props.t("toolCall.io.copyOutputTitle")}
      >
        <Copy class="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

export function renderDiagnosticsSection(
  t: (key: string, params?: Record<string, unknown>) => string,
  view: DiagnosticsView,
  expanded: boolean,
  toggle: () => void,
  fileLabel: string,
) {
  if (!hasDiagnosticMessages(view.diagnostics)) return null
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
        <span class="tool-call-summary">{t("toolCall.diagnostics.title")}</span>
        <Show when={view.truncated}>
          <span class="tool-call-diagnostic-message">{t("toolCall.output.truncated")}</span>
        </Show>
        <span class="tool-call-diagnostics-file" title={fileLabel}>
          {fileLabel}
        </span>
      </button>
      <Show when={expanded}>
        <div class="tool-call-diagnostics" role="region" aria-label={t("toolCall.diagnostics.ariaLabel")}>
          <DiagnosticsPayloadAccess diagnostics={view.diagnostics} truncated={view.truncated} t={t} />
          <div class="tool-call-diagnostics-body" role="list">
            <For each={view.entries}>
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
                  <span class="tool-call-diagnostic-message" dir="auto">{entry.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
