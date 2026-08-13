import type { ToolState } from "../../types/tool-state"
import { getRelativePath, isToolStateCompleted, isToolStateError, isToolStateRunning } from "./utils"
import { tGlobal } from "../../lib/i18n"
import { selectSeverityBounded } from "./diagnostic-selection"

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
  messageTruncated: boolean
  filePath: string
  displayPath: string
  line: number
  column: number
}

export interface DiagnosticsView {
  diagnostics: DiagnosticsMap
  entries: DiagnosticEntry[]
  key?: string
  truncated: boolean
}

function diagnosticListHasMessages(list: unknown): boolean {
  if (!Array.isArray(list)) return false
  for (let index = 0; index < list.length && index < 10_000; index += 1) {
    if (typeof list[index]?.message === "string") return true
  }
  return list.length > 10_000
}

const DIAGNOSTIC_SCAN_LIMIT = 10_000

export function hasDiagnosticMessages(diagnostics: DiagnosticsMap): boolean {
  let scanned = 0
  let scannedKeys = 0
  for (const key in diagnostics) {
    if (!Object.prototype.hasOwnProperty.call(diagnostics, key)) continue
    scannedKeys += 1
    if (scannedKeys > DIAGNOSTIC_SCAN_LIMIT) return true
    const list = diagnostics[key]
    if (!Array.isArray(list)) continue
    const remaining = DIAGNOSTIC_SCAN_LIMIT - scanned
    if (remaining <= 0) return true
    for (let index = 0; index < list.length && index < remaining; index += 1) {
      scanned += 1
      if (typeof list[index]?.message === "string") return true
    }
    if (list.length > remaining) return true
  }
  return false
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

export function extractDiagnosticsView(state: ToolState | undefined): DiagnosticsView {
  if (!state) return buildDiagnosticView({}, [])
  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  if (!supportsMetadata) return buildDiagnosticView({}, [])

  const metadata = (state.metadata || {}) as Record<string, unknown>
  const input = (state.input || {}) as Record<string, unknown>
  const diagnosticsMap = metadata?.diagnostics as DiagnosticsMap | undefined
  if (!diagnosticsMap) return buildDiagnosticView({}, [])

  const view = buildDiagnosticView(diagnosticsMap, [input.filePath, metadata.filePath, metadata.filepath, input.path].map((value) =>
    typeof value === "string" ? value : undefined,
  ))
  let scanned = 0
  let scannedKeys = 0
  for (const key in diagnosticsMap) {
    if (!Object.prototype.hasOwnProperty.call(diagnosticsMap, key)) continue
    scannedKeys += 1
    if (scannedKeys > DIAGNOSTIC_SCAN_LIMIT) return { ...view, truncated: true }
    const list = diagnosticsMap[key]
    if (!Array.isArray(list)) continue
    const remaining = DIAGNOSTIC_SCAN_LIMIT - scanned
    if (remaining <= 0) return { ...view, truncated: true }
    for (let index = 0; index < list.length && index < remaining; index += 1) {
      scanned += 1
      if (key !== view.key && typeof list[index]?.message === "string") return { ...view, truncated: true }
    }
    if (list.length > remaining) return { ...view, truncated: true }
  }
  return view
}

export function extractDiagnostics(state: ToolState | undefined): DiagnosticEntry[] {
  return extractDiagnosticsView(state).entries
}

export function resolveDiagnosticsKey(diagnostics: DiagnosticsMap, preferredPaths: Array<string | undefined>): string | undefined {
  const normalizedPreferred = preferredPaths
    .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 4_096)
    .map((value) => normalizeDiagnosticPath(value))

  if (normalizedPreferred.length === 0) return undefined

  for (const preferred of normalizedPreferred) {
    if (diagnostics[preferred]) return preferred
  }

  const keys: string[] = []
  let scannedKeys = 0
  for (const key in diagnostics) {
    if (!Object.prototype.hasOwnProperty.call(diagnostics, key)) continue
    scannedKeys += 1
    if (scannedKeys > 10_000) break
    if (key.length > 4_096) continue
    keys.push(key)
  }

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

export function buildDiagnosticView(diagnostics: DiagnosticsMap, preferredPaths: Array<string | undefined>): DiagnosticsView {
  const key = resolveDiagnosticsKey(diagnostics, preferredPaths)
  if (!key) return { diagnostics, entries: [], truncated: false }

  const list = diagnostics[key]
  if (!Array.isArray(list) || list.length === 0) return { diagnostics, entries: [], key, truncated: false }

  const limit = 100
  const entries: DiagnosticEntry[] = []
  const normalizedPath = normalizeDiagnosticPath(key)
  const selected = selectSeverityBounded(
    list,
    (diagnostic) => diagnostic && typeof diagnostic.message === "string"
      ? getSeverityMeta(determineSeverityTone(diagnostic.severity)).rank
      : undefined,
    limit,
  )
  for (const diagnostic of selected) {
    const index = entries.length
    if (!diagnostic || typeof diagnostic.message !== "string") continue
    const tone = determineSeverityTone(typeof diagnostic.severity === "number" ? diagnostic.severity : undefined)
    const severityMeta = getSeverityMeta(tone)
    const line = typeof diagnostic.range?.start?.line === "number" ? diagnostic.range.start.line + 1 : 0
    const column = typeof diagnostic.range?.start?.character === "number" ? diagnostic.range.start.character + 1 : 0
    entries.push({
      id: String(index),
      severity: severityMeta.rank,
      tone,
      label: severityMeta.label,
      icon: severityMeta.icon,
      message: diagnostic.message.slice(0, 2_000),
      messageTruncated: diagnostic.message.length > 2_000,
      filePath: normalizedPath,
      displayPath: getRelativePath(normalizedPath),
      line,
      column,
    })
  }

  return {
    diagnostics,
    entries,
    key,
    truncated: list.length > entries.length || entries.some((entry) => entry.messageTruncated),
  }
}

export function buildDiagnosticEntries(diagnostics: DiagnosticsMap, preferredPaths: Array<string | undefined>): DiagnosticEntry[] {
  return buildDiagnosticView(diagnostics, preferredPaths).entries
}

export function diagnosticFileName(entries: DiagnosticEntry[]) {
  const first = entries[0]
  return first ? first.displayPath : ""
}
