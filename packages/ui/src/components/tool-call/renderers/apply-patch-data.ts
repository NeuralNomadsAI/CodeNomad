export type ApplyPatchFile = {
  filePath?: string
  relativePath?: string
  type?: string
  diff?: string
  patch?: string
}

export function getApplyPatchCopyText(files: ApplyPatchFile[], limit = Number.POSITIVE_INFINITY): string {
  const diffs: string[] = []
  let characters = 0
  for (const file of files) {
    const diff = typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""
    if (!diff.trim()) continue
    const remaining = limit - characters
    if (remaining <= 0) break
    diffs.push(diff.slice(0, remaining))
    characters += Math.min(diff.length, remaining)
    if (diff.length > remaining) break
  }
  return diffs.join("\n")
}
