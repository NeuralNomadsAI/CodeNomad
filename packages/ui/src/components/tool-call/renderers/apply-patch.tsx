import { For, Show, createMemo } from "solid-js"
import { Copy } from "lucide-solid"
import type { ToolRenderer } from "../types"
import { getRelativePath, getToolName, isToolStateCompleted, limitToolOutputForRender, readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"
import { buildDiagnosticEntries, type DiagnosticEntry, type DiagnosticsMap } from "../diagnostics"
import { getApplyPatchToolSearchText } from "../search-text"
import { copyToClipboard } from "../../../lib/clipboard"

type ApplyPatchFile = {
  filePath?: string
  relativePath?: string
  type?: string
  diff?: string
  patch?: string
}

const APPLY_PATCH_FILE_RENDER_LIMIT = 20

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
  getSearchText: getApplyPatchToolSearchText,
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
  getOutputChrome({ toolState, t }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined

    const payload = readToolStatePayload(state)
    const files = Array.isArray((payload.metadata as any).files) ? ((payload.metadata as any).files as ApplyPatchFile[]) : []
    const diffs = files
      .map((file) => (typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""))
      .filter((diff) => diff.trim().length > 0)
    if (diffs.length > 0) {
      if (diffs.reduce((total, diff) => total + diff.length, 0) > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT) {
        return {
          language: "diff",
          suppressInnerHeader: false,
          actions: (
            <button
              type="button"
              class="file-viewer-toolbar-icon-button"
              onClick={() => void copyToClipboard(diffs.join("\n"))}
              aria-label={t("toolCall.diff.copyPatch")}
              title={t("toolCall.diff.copyPatch")}
            >
              <Copy class="h-4 w-4" aria-hidden="true" />
            </button>
          ),
        }
      }
      return { language: "diff", copyText: diffs.join("\n"), suppressInnerHeader: false }
    }

    const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
    if (!fallback) return undefined
    return { language: "text", copyText: fallback, wrapToggle: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderDiff, renderMarkdown, t }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const payload = readToolStatePayload(state)
    const allFiles = createMemo(() => {
      const list = (payload.metadata as any).files
      return Array.isArray(list) ? (list as ApplyPatchFile[]) : []
    })
    const files = createMemo(() => allFiles().slice(0, APPLY_PATCH_FILE_RENDER_LIMIT))
    const diagnosticsMap = createMemo(() => {
      const value = (payload.metadata as any).diagnostics
      return value && typeof value === "object" ? (value as DiagnosticsMap) : {}
    })

    if (files().length === 0) {
      const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
      if (!fallback) return null
      return renderMarkdown({ content: limitToolOutputForRender(fallback), size: "large", disableHighlight: state.status === "running" })
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
        <Show when={allFiles().length > APPLY_PATCH_FILE_RENDER_LIMIT}>
          <div class="tool-call-diagnostic-message">{t("toolCall.output.truncated")}</div>
        </Show>
      </div>
    )
  },
}
