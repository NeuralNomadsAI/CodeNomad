const HUNK_PATTERN = /(^|\n)@@/m
const FILE_MARKER_PATTERN = /(^|\n)(diff --git |--- |\+\+\+)/
const BEGIN_PATCH_PATTERN = /^\*\*\* (Begin|End) Patch/
const UPDATE_FILE_PATTERN = /^\*\*\* Update File: (.+)$/

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("```")) return trimmed
  const lines = trimmed.split("\n")
  if (lines.length < 2) return ""
  const lastLine = lines[lines.length - 1]
  if (!lastLine.startsWith("```")) return trimmed
  return lines.slice(1, -1).join("\n")
}

export function normalizeDiffText(raw: string): string {
  if (!raw) return ""
  const withoutFence = stripCodeFence(raw.replace(/\r\n/g, "\n"))
  const lines = withoutFence.split("\n").map((line) => line.replace(/\s+$/u, ""))

  let pendingFilePath: string | null = null
  const cleanedLines: string[] = []

  for (const line of lines) {
    if (!line) continue
    if (BEGIN_PATCH_PATTERN.test(line)) {
      continue
    }
    const updateMatch = line.match(UPDATE_FILE_PATTERN)
    if (updateMatch) {
      pendingFilePath = updateMatch[1]?.trim() || null
      continue
    }
    cleanedLines.push(line)
  }

  if (pendingFilePath && !FILE_MARKER_PATTERN.test(cleanedLines.join("\n"))) {
    cleanedLines.unshift(`+++ b/${pendingFilePath}`)
    cleanedLines.unshift(`--- a/${pendingFilePath}`)
  }

  return cleanedLines.join("\n").trim()
}

export function isRenderableDiffText(raw?: string | null): raw is string {
  if (!raw) return false
  const normalized = normalizeDiffText(raw)
  if (!normalized) return false
  return HUNK_PATTERN.test(normalized)
}
