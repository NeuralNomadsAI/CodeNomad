import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { getToolName, isToolStateCompleted, limitToolOutputForRender, limitToolTitleForRender, readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"
import { buildDiagnosticView, hasDiagnosticMessages, type DiagnosticEntry, type DiagnosticsMap } from "../diagnostics"
import { DiagnosticsPayloadAccess } from "../diagnostics-section"
import { getApplyPatchToolSearchText } from "../search-text"
import { APPLY_PATCH_FILE_RENDER_LIMIT, getApplyPatchCopyAccess, getApplyPatchCopyText, getApplyPatchDiagnosticPaths, getApplyPatchFilesForRender, getApplyPatchPathLabel, getApplyPatchRenderData, hasApplyPatchCopyText, type ApplyPatchFile } from "./apply-patch-data"

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
    const fallback = isToolStateCompleted(state) && typeof state.output === "string" && state.output.length > 0 ? state.output : null
    const access = getApplyPatchCopyAccess(files, fallback)
    if (!access) return undefined
    return access.language === "diff"
      ? { ...access, suppressInnerHeader: false }
      : { ...access, wrapToggle: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderDiff, renderMarkdown, t }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const payload = readToolStatePayload(state)
    const diagnosticsMap = createMemo(() => {
      const value = (payload.metadata as any).diagnostics
      return value && typeof value === "object" ? (value as DiagnosticsMap) : {}
    })
    const allFiles = createMemo(() => {
      const list = (payload.metadata as any).files
      return getApplyPatchFilesForRender(Array.isArray(list) ? list as ApplyPatchFile[] : [], getApplyPatchDiagnosticPaths(diagnosticsMap()))
    })
    const renderData = createMemo(() => getApplyPatchRenderData(allFiles().files, APPLY_PATCH_FILE_RENDER_LIMIT, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, allFiles().truncated))
    const files = createMemo(() => renderData().rendered)
    const fallback = createMemo(() => {
      if (!isToolStateCompleted(state) || hasApplyPatchCopyText(files().map(({ file }) => file))) return null
      return typeof state.output === "string" && state.output.length > 0 ? state.output : null
    })
    const diagnosticViews = createMemo(() => {
      let remaining = 100
      return files().map(({ file }) => {
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
      let scannedKeys = 0
      for (const key in diagnosticsMap()) {
        if (!Object.prototype.hasOwnProperty.call(diagnosticsMap(), key)) continue
        scannedKeys += 1
        if (scannedKeys > 10_000) return true
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

    if (files().length === 0 && !fallback() && !renderData().truncated) return null

    return (
      <div class="tool-call-apply-patch">
        <Show when={fallback()}>
          {(content) => renderMarkdown({ content: limitToolOutputForRender(content()), size: "large", disableHighlight: state.status === "running" })}
        </Show>
        <For each={files()}>
          {(renderedFile, index) => {
            const file = renderedFile.file
            const labelBase = file.relativePath || file.filePath || t("toolCall.applyPatch.fileFallback", { number: index() + 1 })
            const label = getApplyPatchPathLabel(labelBase)
            const fullDiff = typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""
            const diffText = renderedFile.diffText
            const filePath = typeof file.filePath === "string" ? file.filePath : file.relativePath
            const entries = createMemo(() => diagnosticViews()[index()]?.entries ?? [])

            return (
              <div class="tool-call-apply-patch-file">
                <Show when={diffText.trim().length > 0}>
                  {renderDiff(
                    { diffText, copyText: fullDiff, filePath },
                    {
                      label: limitToolTitleForRender(t("toolCall.diff.label.withPath", { path: label })),
                      cacheKey: `apply_patch:${index()}`,
                    },
                  )}
                </Show>
                <DiagnosticsInline entries={entries()} label={label} t={t} />
              </div>
            )
          }}
        </For>
        <Show when={renderData().truncated}>
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
