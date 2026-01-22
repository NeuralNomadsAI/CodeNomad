import type { ToolState } from "@opencode-ai/sdk"
import { getRelativePath, isToolStateCompleted, isToolStateError, isToolStateRunning } from "./utils"

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

function normalizeDiagnosticPath(path: string) {
  return path.replace(/\\/g, "/")
}

function determineSeverityTone(severity?: number): DiagnosticEntry["tone"] {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  return "info"
}

function getSeverityMeta(tone: DiagnosticEntry["tone"]) {
  if (tone === "error") return { label: "ERR", icon: "!", rank: 0 }
  if (tone === "warning") return { label: "WARN", icon: "!", rank: 1 }
  return { label: "INFO", icon: "i", rank: 2 }
}

export function extractDiagnostics(state: ToolState | undefined): DiagnosticEntry[] {
  if (!state) return []
  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  if (!supportsMetadata) return []

  const metadata = (state.metadata || {}) as Record<string, unknown>
  const input = (state.input || {}) as Record<string, unknown>
  const diagnosticsMap = metadata?.diagnostics as Record<string, LspDiagnostic[] | undefined> | undefined
  if (!diagnosticsMap) return []

  const preferredPath = [input.filePath, metadata.filePath, metadata.filepath, input.path].find(
    (value) => typeof value === "string" && value.length > 0,
  ) as string | undefined

  const normalizedPreferred = preferredPath ? normalizeDiagnosticPath(preferredPath) : undefined
  if (!normalizedPreferred) return []
  const candidateEntries = Object.entries(diagnosticsMap).filter(([, items]) => Array.isArray(items) && items.length > 0)
  if (candidateEntries.length === 0) return []

  const prioritizedEntries = candidateEntries.filter(([path]) => {
    const normalized = normalizeDiagnosticPath(path)
    return normalized === normalizedPreferred
  })

  if (prioritizedEntries.length === 0) return []

  const entries: DiagnosticEntry[] = []
  for (const [pathKey, list] of prioritizedEntries) {
    if (!Array.isArray(list)) continue
    const normalizedPath = normalizeDiagnosticPath(pathKey)
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
  }

  return entries.sort((a, b) => a.severity - b.severity)
}

export function diagnosticFileName(entries: DiagnosticEntry[]) {
  const first = entries[0]
  return first ? first.displayPath : ""
}
