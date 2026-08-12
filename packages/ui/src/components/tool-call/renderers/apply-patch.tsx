import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { getRelativePath, getToolName, isToolStateCompleted, limitToolOutputForRender, readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"
import { buildDiagnosticView, hasDiagnosticMessages, type DiagnosticEntry, type DiagnosticsMap } from "../diagnostics"
import { DiagnosticsPayloadAccess } from "../diagnostics-section"
import { getApplyPatchToolSearchText } from "../search-text"
import { getApplyPatchCopyText, type ApplyPatchFile } from "./apply-patch-data"

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
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined

    const payload = readToolStatePayload(state)
    const files = Array.isArray((payload.metadata as any).files) ? ((payload.metadata as any).files as ApplyPatchFile[]) : []
    if (files.some((file) => typeof file.diff === "string" || typeof file.patch === "string")) {
      return {
        language: "diff",
        getCopyText: () => getApplyPatchCopyText(files),
        suppressInnerHeader: false,
      }
    }

    const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
    if (!fallback) return undefined
    return { language: "text", getCopyText: () => fallback, wrapToggle: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderDiff, renderMarkdown, t }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const payload = readToolStatePayload(state)
    const allFiles = createMemo(() => {
      const list = (payload.metadata as any).files
      return Array.isArray(list) ? (list as ApplyPatchFile[]) : []
    })
    const files = createMemo(() => {
      const rendered: ApplyPatchFile[] = []
      let characters = 0
      for (const file of allFiles()) {
        if (rendered.length >= APPLY_PATCH_FILE_RENDER_LIMIT || characters >= TOOL_OUTPUT_RENDER_CHARACTER_LIMIT) break
        const diff = typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""
        const remaining = TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - characters
        rendered.push(diff.length > remaining ? { ...file, diff: file.diff ? diff.slice(0, remaining + 1) : undefined, patch: file.patch ? diff.slice(0, remaining + 1) : undefined } : file)
        characters += Math.min(diff.length, remaining)
      }
      return rendered
    })
    const diagnosticsMap = createMemo(() => {
      const value = (payload.metadata as any).diagnostics
      return value && typeof value === "object" ? (value as DiagnosticsMap) : {}
    })
    const diagnosticViews = createMemo(() => {
      let remaining = 100
      return files().map((file) => {
        const view = buildDiagnosticView(diagnosticsMap(), [file.filePath, file.relativePath])
        const entries = view.entries.slice(0, remaining)
        remaining -= entries.length
        return { ...view, entries, truncated: view.truncated || entries.length < view.entries.length }
      })
    })
    const diagnosticsTruncated = createMemo(() => {
      const views = diagnosticViews()
      const renderedKeys = new Set(views.map((view) => view.key).filter(Boolean))
      if (views.some((view) => view.truncated)) return true
      let scanned = 0
      for (const key in diagnosticsMap()) {
        if (!Object.prototype.hasOwnProperty.call(diagnosticsMap(), key)) continue
        const list = diagnosticsMap()[key]
        if (!renderedKeys.has(key) && Array.isArray(list)) {
          const remaining = 10_000 - scanned
          if (remaining <= 0) return true
          for (let index = 0; index < list.length && index < remaining; index += 1) {
            scanned += 1
            if (typeof list[index]?.message === "string") return true
          }
          if (list.length > remaining) return true
        }
      }
      return false
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
            const entries = createMemo(() => diagnosticViews()[index()]?.entries ?? [])

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
        <Show when={allFiles().length > files().length}>
          <div class="tool-call-diagnostic-message" role="status">{t("toolCall.output.truncated")}</div>
        </Show>
        <Show when={hasDiagnosticMessages(diagnosticsMap())}>
          <div class="tool-call-diagnostics-wrapper">
            <div class="tool-call-diagnostics">
              <DiagnosticsPayloadAccess diagnostics={diagnosticsMap()} truncated={diagnosticsTruncated()} t={t} />
            </div>
          </div>
        </Show>
      </div>
    )
  },
}
