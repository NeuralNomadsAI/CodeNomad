import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { getRelativePath, getToolName, isToolStateCompleted, readToolStatePayload } from "../utils"
import { buildDiagnosticEntries, type DiagnosticEntry, type DiagnosticsMap } from "../diagnostics"

type ApplyPatchFile = {
  filePath?: string
  relativePath?: string
  type?: string
  diff?: string
  patch?: string
}

function DiagnosticsInline(props: { entries: DiagnosticEntry[]; label: string; t: (key: string, params?: Record<string, unknown>) => string }) {
  return (
    <Show when={props.entries.length > 0}>
      <div class="tool-call-diagnostics-wrapper">
        <div
          class="tool-call-diagnostics"
          role="region"
          aria-label={props.t("toolCall.diagnostics.ariaLabel.withLabel", { label: props.label })}
        >
          <div class="tool-call-diagnostics-body" role="list">
            <For each={props.entries}>
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
      </div>
    </Show>
  )
}

export const applyPatchRenderer: ToolRenderer = {
  tools: ["apply_patch"],
  getAction: ({ t }) => t("toolCall.applyPatch.action.preparing"),
  getTitle({ toolState, t }) {
    const state = toolState()
    if (!state) return undefined
    if (state.status === "pending") return getToolName("apply_patch")
    const { metadata } = readToolStatePayload(state)
    const files = Array.isArray((metadata as any).files) ? ((metadata as any).files as ApplyPatchFile[]) : []
    if (files.length > 0) {
      const tool = getToolName("apply_patch")
      return files.length === 1
        ? t("toolCall.applyPatch.title.withFileCount.one", { tool, count: files.length })
        : t("toolCall.applyPatch.title.withFileCount.other", { tool, count: files.length })
    }
    return getToolName("apply_patch")
  },
  renderBody({ toolState, renderDiff, renderMarkdown, t }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const payload = readToolStatePayload(state)
    const files = createMemo(() => {
      const list = (payload.metadata as any).files
      return Array.isArray(list) ? (list as ApplyPatchFile[]) : []
    })
    const diagnosticsMap = createMemo(() => {
      const value = (payload.metadata as any).diagnostics
      return value && typeof value === "object" ? (value as DiagnosticsMap) : {}
    })

    if (files().length === 0) {
      const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
      if (!fallback) return null
      return renderMarkdown({ content: fallback, size: "large", disableHighlight: state.status === "running" })
    }

    return (
      <div class="tool-call-apply-patch">
        <For each={files()}>
          {(file, index) => {
            const labelBase = file.relativePath || file.filePath || t("toolCall.applyPatch.fileFallback", { number: index() + 1 })
            const diffText = typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""
            const filePath = typeof file.filePath === "string" ? file.filePath : file.relativePath
            const entries = createMemo(() => buildDiagnosticEntries(diagnosticsMap(), [file.filePath, file.relativePath]))

            return (
              <div class="tool-call-apply-patch-file">
                <Show when={diffText.trim().length > 0}>
                  {renderDiff(
                    { diffText, filePath },
                    {
                      label: t("toolCall.diff.label.withPath", { path: getRelativePath(labelBase) }),
                      cacheKey: `apply_patch:${labelBase}:${index()}`,
                    },
                  )}
                </Show>
                <DiagnosticsInline entries={entries()} label={labelBase} t={t} />
              </div>
            )
          }}
        </For>
      </div>
    )
  },
}
