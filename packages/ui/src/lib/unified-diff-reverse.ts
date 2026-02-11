import { applyPatch, parsePatch } from "diff"

type ParsedPatchIndex = ReturnType<typeof parsePatch>[number]
type ParsedHunk = ParsedPatchIndex["hunks"][number]

type SdkPatch = {
  oldFileName: string
  newFileName: string
  oldHeader?: string
  newHeader?: string
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: Array<string>
  }>
  index?: string
}

function invertPatchLine(line: string): string {
  if (!line) return line
  const op = line[0]
  if (op === "+") return `-${line.slice(1)}`
  if (op === "-") return `+${line.slice(1)}`
  return line
}

function reverseParsedHunk(hunk: ParsedHunk): ParsedHunk {
  return {
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    lines: hunk.lines.map(invertPatchLine),
    linedelimiters: Array.isArray((hunk as any).linedelimiters) ? (hunk as any).linedelimiters : [],
  } as ParsedHunk
}

function reverseParsedIndex(index: ParsedPatchIndex): ParsedPatchIndex {
  const hunks = Array.isArray(index.hunks) ? index.hunks : []
  return {
    ...index,
    oldFileName: (index as any).newFileName,
    newFileName: (index as any).oldFileName,
    oldHeader: (index as any).newHeader,
    newHeader: (index as any).oldHeader,
    hunks: hunks.map(reverseParsedHunk),
  } as ParsedPatchIndex
}

export function buildUnifiedDiffFromSdkPatch(patch: SdkPatch): string {
  const oldName = patch.oldFileName || "a/file"
  const newName = patch.newFileName || "b/file"
  const oldHeader = patch.oldHeader ? `\t${patch.oldHeader}` : ""
  const newHeader = patch.newHeader ? `\t${patch.newHeader}` : ""

  const lines: string[] = []
  if (patch.index) {
    // jsdiff can parse arbitrary metadata lines before file headers.
    lines.push(`Index: ${patch.index}`)
  }
  lines.push(`--- ${oldName}${oldHeader}`)
  lines.push(`+++ ${newName}${newHeader}`)
  for (const hunk of patch.hunks || []) {
    const oldRange = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`
    const newRange = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`
    lines.push(`@@ -${oldRange} +${newRange} @@`)
    for (const line of hunk.lines || []) {
      lines.push(line)
    }
  }
  return `${lines.join("\n")}\n`
}

export function tryReverseApplyUnifiedDiff(afterText: string, diffText: string): string | null {
  const normalized = (diffText ?? "").trim()
  if (!normalized) return null

  const parsed = parsePatch(diffText)
  if (!Array.isArray(parsed) || parsed.length === 0) return null

  const reversed = reverseParsedIndex(parsed[0])
  const result = applyPatch(afterText ?? "", reversed)
  return typeof result === "string" ? result : null
}
