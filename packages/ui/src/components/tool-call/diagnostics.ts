import type { ToolState } from "@opencode-ai/sdk/v2"
import { getRelativePath, isToolStateCompleted, isToolStateError, isToolStateRunning } from "./utils"
import { tGlobal } from "../../lib/i18n"

interface LspRangePosition {
  line?: number
  character?: number
}

interface LspRange {
  start?: LspRangePosition
}

interface LspDiagnostic {
  message?: string
  severity?: number
  range?: LspRange
}

export type DiagnosticsMap = Record<string, LspDiagnostic[] | undefined>

export interface DiagnosticEntry {
  id: string
  severity: number
  tone: "error" | "warning" | "info"
  label: string
  icon: string
  message: string
  filePath: string
  displayPath: string
  line: number
  column: number
}

export function normalizeDiagnosticPath(path: string) {
  return path.replace(/\\/g, "/")
}

function determineSeverityTone(severity?: number): DiagnosticEntry["tone"] {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  return "info"
}

function getSeverityMeta(tone: DiagnosticEntry["tone"]) {
  if (tone === "error") return { label: tGlobal("toolCall.diagnostics.severity.error.short"), icon: "!", rank: 0 }
  if (tone === "warning") return { label: tGlobal("toolCall.diagnostics.severity.warning.short"), icon: "!", rank: 1 }
  return { label: tGlobal("toolCall.diagnostics.severity.info.short"), icon: "i", rank: 2 }
}

export function extractDiagnostics(state: ToolState | undefined): DiagnosticEntry[] {
  if (!state) return []
  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  if (!supportsMetadata) return []

  const metadata = (state.metadata || {}) as Record<string, unknown>
  const input = (state.input || {}) as Record<string, unknown>
  const diagnosticsMap = metadata?.diagnostics as DiagnosticsMap | undefined
  if (!diagnosticsMap) return []

  return buildDiagnosticEntries(diagnosticsMap, [input.filePath, metadata.filePath, metadata.filepath, input.path].map((value) =>
    typeof value === "string" ? value : undefined,
  ))
}

export function resolveDiagnosticsKey(diagnostics: DiagnosticsMap, preferredPaths: Array<string | undefined>): string | undefined {
  if (Object.keys(diagnostics).length === 0) return undefined

  const normalizedPreferred = preferredPaths
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => normalizeDiagnosticPath(value))

  if (normalizedPreferred.length === 0) return undefined

  for (const preferred of normalizedPreferred) {
    if (diagnostics[preferred]) return preferred
  }

  const keys = Object.keys(diagnostics)

  for (const preferred of normalizedPreferred) {
    const direct = keys.find((key) => normalizeDiagnosticPath(key) === preferred)
    if (direct) return direct
  }

  for (const preferred of normalizedPreferred) {
    const suffixMatch = keys.find((key) => {
      const normalized = normalizeDiagnosticPath(key)
      return normalized === preferred || normalized.endsWith("/" + preferred)
    })
    if (suffixMatch) return suffixMatch
  }

  return undefined
}

export function buildDiagnosticEntries(diagnostics: DiagnosticsMap, preferredPaths: Array<string | undefined>): DiagnosticEntry[] {
  const key = resolveDiagnosticsKey(diagnostics, preferredPaths)
  if (!key) return []

  const list = diagnostics[key]
  if (!Array.isArray(list) || list.length === 0) return []

  const entries: DiagnosticEntry[] = []
  const normalizedPath = normalizeDiagnosticPath(key)
  for (let index = 0; index < list.length; index++) {
    const diagnostic = list[index]
    if (!diagnostic || typeof diagnostic.message !== "string") continue
    const tone = determineSeverityTone(typeof diagnostic.severity === "number" ? diagnostic.severity : undefined)
    const severityMeta = getSeverityMeta(tone)
    const line = typeof diagnostic.range?.start?.line === "number" ? diagnostic.range.start.line + 1 : 0
    const column = typeof diagnostic.range?.start?.character === "number" ? diagnostic.range.start.character + 1 : 0
    entries.push({
      id: `${normalizedPath}-${index}-${diagnostic.message}`,
      severity: severityMeta.rank,
      tone,
      label: severityMeta.label,
      icon: severityMeta.icon,
      message: diagnostic.message,
      filePath: normalizedPath,
      displayPath: getRelativePath(normalizedPath),
      line,
      column,
    })
  }

  return entries.sort((a, b) => a.severity - b.severity)
}

export function diagnosticFileName(entries: DiagnosticEntry[]) {
  const first = entries[0]
  return first ? first.displayPath : ""
}
