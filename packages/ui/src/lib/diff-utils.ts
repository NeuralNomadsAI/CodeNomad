const HUNK_PATTERN = /(^|\n)@@/m
const FILE_MARKER_PATTERN = /(^|\n)(diff --git |--- |\+\+\+)/
const BEGIN_PATCH_PATTERN = /^\*\*\* (Begin|End) Patch/
const UPDATE_FILE_PATTERN = /^\*\*\* Update File: (.+)$/
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

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

export function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  if (!patch || patch.trim().length === 0) {
    return { before: "", after: "" }
  }

  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  const beforeLines: string[] = []
  const afterLines: string[] = []

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff --git")) {
      continue
    }
    if (HUNK_HEADER_PATTERN.test(line)) {
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      beforeLines.push(line.slice(1))
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      afterLines.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      beforeLines.push(line.slice(1))
      afterLines.push(line.slice(1))
    } else if (line === "") {
      beforeLines.push("")
      afterLines.push("")
    } else {
      beforeLines.push(line)
      afterLines.push(line)
    }
  }

  while (beforeLines.length > 0 && beforeLines[beforeLines.length - 1] === "") {
    beforeLines.pop()
  }
  while (afterLines.length > 0 && afterLines[afterLines.length - 1] === "") {
    afterLines.pop()
  }

  return {
    before: beforeLines.join("\n"),
    after: afterLines.join("\n"),
  }
}
