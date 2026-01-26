import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { getRelativePath, getToolName, isToolStateCompleted, readToolStatePayload } from "../utils"
import type { DiagnosticEntry } from "../diagnostics"

type LspRangePosition = {
  line?: number
  character?: number
}

type LspRange = {
  start?: LspRangePosition
}

type LspDiagnostic = {
  message?: string
  severity?: number
  range?: LspRange
}

type ApplyPatchFile = {
  filePath?: string
  relativePath?: string
  type?: string
  diff?: string
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/")
}

function determineSeverityTone(severity?: number): DiagnosticEntry["tone"] {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  return "info"
}

function getSeverityMeta(tone: DiagnosticEntry["tone"], t: (key: string, params?: Record<string, unknown>) => string) {
  if (tone === "error") return { label: t("toolCall.diagnostics.severity.error.short"), icon: "!", rank: 0 }
  if (tone === "warning") return { label: t("toolCall.diagnostics.severity.warning.short"), icon: "!", rank: 1 }
  return { label: t("toolCall.diagnostics.severity.info.short"), icon: "i", rank: 2 }
}

function resolveDiagnosticsKey(
  diagnostics: Record<string, LspDiagnostic[] | undefined>,
  file: ApplyPatchFile,
): string | undefined {
  const absolute = typeof file.filePath === "string" ? normalizePath(file.filePath) : ""
  const relative = typeof file.relativePath === "string" ? normalizePath(file.relativePath) : ""
  if (absolute && diagnostics[absolute]) return absolute
  if (relative && diagnostics[relative]) return relative

  if (absolute) {
    const direct = Object.keys(diagnostics).find((key) => normalizePath(key) === absolute)
    if (direct) return direct
  }

  if (relative) {
    const suffixMatch = Object.keys(diagnostics).find((key) => {
      const normalized = normalizePath(key)
      return normalized === relative || normalized.endsWith("/" + relative)
    })
    if (suffixMatch) return suffixMatch
  }

  return undefined
}

function buildDiagnostics(
  diagnostics: Record<string, LspDiagnostic[] | undefined>,
  file: ApplyPatchFile,
  t: (key: string, params?: Record<string, unknown>) => string,
): DiagnosticEntry[] {
  const key = resolveDiagnosticsKey(diagnostics, file)
  if (!key) return []
  const list = diagnostics[key]
  if (!Array.isArray(list) || list.length === 0) return []

  const normalizedKey = normalizePath(key)
  const entries: DiagnosticEntry[] = []
  for (let index = 0; index < list.length; index++) {
    const diagnostic = list[index]
    if (!diagnostic || typeof diagnostic.message !== "string") continue

    const tone = determineSeverityTone(typeof diagnostic.severity === "number" ? diagnostic.severity : undefined)
    const severityMeta = getSeverityMeta(tone, t)
    const line = typeof diagnostic.range?.start?.line === "number" ? diagnostic.range.start.line + 1 : 0
    const column = typeof diagnostic.range?.start?.character === "number" ? diagnostic.range.start.character + 1 : 0

    entries.push({
      id: `${normalizedKey}-${index}-${diagnostic.message}`,
      severity: severityMeta.rank,
      tone,
      label: severityMeta.label,
      icon: severityMeta.icon,
      message: diagnostic.message,
      filePath: normalizedKey,
      displayPath: getRelativePath(normalizedKey),
      line,
      column,
    })
  }

  return entries.sort((a, b) => a.severity - b.severity)
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
      return value && typeof value === "object" ? (value as Record<string, LspDiagnostic[] | undefined>) : {}
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
            const diffText = typeof file.diff === "string" ? file.diff : ""
            const filePath = typeof file.filePath === "string" ? file.filePath : file.relativePath
            const entries = createMemo(() => buildDiagnostics(diagnosticsMap(), file, t))

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
