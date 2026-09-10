export type ApplyPatchFile = {
  filePath?: string
  relativePath?: string
  type?: string
  diff?: string
  patch?: string
}

export const APPLY_PATCH_FILE_RENDER_LIMIT = 20
const APPLY_PATCH_SCAN_LIMIT = 10_000

export function getApplyPatchPathLabel(path: string, limit = 384): string {
  const tail = path.slice(-(limit + 1)).replace(/\\/g, "/")
  const separator = tail.lastIndexOf("/")
  const label = separator >= 0 ? tail.slice(separator + 1) : tail
  return label.length <= limit ? label : `...${label.slice(-(limit - 3))}`
}

export function* getApplyPatchDiagnosticPaths(diagnostics: Record<string, unknown>): Generator<string> {
  for (const path in diagnostics) if (Object.prototype.hasOwnProperty.call(diagnostics, path)) yield path
}

function getApplyPatchDiff(file: ApplyPatchFile): string {
  return typeof file.diff === "string" ? file.diff : typeof file.patch === "string" ? file.patch : ""
}

function probeApplyPatchCopyText(file: ApplyPatchFile, limit: number) {
  const diff = getApplyPatchDiff(file)
  const prefix = diff.slice(0, Math.max(0, limit))
  return { hasContent: /\S/.test(prefix), scanned: prefix.length, truncated: prefix.length < diff.length }
}

export function hasApplyPatchCopyText(files: ApplyPatchFile[], scanLimit = APPLY_PATCH_SCAN_LIMIT): boolean {
  let characters = 0
  let index = 0
  for (; index < files.length && index < scanLimit; index += 1) {
    const probe = probeApplyPatchCopyText(files[index], scanLimit - characters)
    if (probe.hasContent || probe.truncated) return true
    characters += probe.scanned
  }
  return index < files.length
}

export function getApplyPatchCopyText(files: ApplyPatchFile[], limit = Number.POSITIVE_INFINITY): string {
  const diffs: string[] = []
  let characters = 0
  for (const file of files) {
    const remaining = limit - characters
    if (remaining <= 0) break
    const diff = getApplyPatchDiff(file)
    const copyText = diff.slice(0, remaining)
    if (!copyText.trim()) {
      if (copyText.length < diff.length) break
      continue
    }
    diffs.push(copyText)
    characters += Math.min(diff.length, remaining)
    if (diff.length > remaining) break
  }
  return diffs.join("\n")
}

export function getApplyPatchCopyOutput(files: ApplyPatchFile[], fallback: unknown): string | null {
  return getApplyPatchCopyText(files) || (typeof fallback === "string" && fallback.length > 0 ? fallback : null)
}

export function getApplyPatchCopyAccess(files: ApplyPatchFile[], fallback: unknown) {
  if (hasApplyPatchCopyText(files)) {
    return { language: "diff" as const, getCopyText: () => getApplyPatchCopyOutput(files, fallback), hasCopyText: true as const }
  }
  if (typeof fallback !== "string" || fallback.length === 0) return undefined
  return { language: "text" as const, getCopyText: () => fallback, hasCopyText: true as const }
}

export function getApplyPatchRenderData(files: ApplyPatchFile[], fileLimit: number, characterLimit: number, sourceTruncated = false) {
  const rendered: Array<{ file: ApplyPatchFile; diffText: string }> = []
  let characters = 0
  let scannedCharacters = 0
  let truncated = sourceTruncated
  for (const file of files) {
    if (rendered.length >= fileLimit || characters >= characterLimit) {
      truncated = true
      break
    }
    const remaining = characterLimit - characters
    const fullDiff = getApplyPatchDiff(file)
    const probe = probeApplyPatchCopyText(file, Math.min(APPLY_PATCH_SCAN_LIMIT - scannedCharacters, remaining))
    scannedCharacters += probe.scanned
    const firstContent = probe.hasContent ? fullDiff.slice(0, probe.scanned).search(/\S/) : -1
    const diffText = firstContent >= 0 ? fullDiff.slice(firstContent, firstContent + remaining) : ""
    rendered.push({ file, diffText })
    characters += diffText.length
    if (probe.truncated || (firstContent >= 0 && fullDiff.length - firstContent > remaining)) truncated = true
  }
  return { rendered, truncated }
}

export function getApplyPatchFilesForRender(files: ApplyPatchFile[], diagnosticPaths: Iterable<string>, limit = APPLY_PATCH_FILE_RENDER_LIMIT) {
  const normalize = (path: string) => path.replace(/\\/g, "/")
  const matchesPath = (left: string, right: string) => left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  const paths: Array<{ raw: string; normalized: string }> = []
  let diagnosticPathsTruncated = false
  for (const path of diagnosticPaths) {
    if (paths.length >= limit) {
      diagnosticPathsTruncated = true
      break
    }
    paths.push({ raw: path, normalized: normalize(path) })
  }
  const rendered: ApplyPatchFile[] = []
  const knownPaths: string[] = []
  let scannedFiles = 0
  let scannedCharacters = 0
  for (let fileIndex = 0; fileIndex < files.length && rendered.length < limit; fileIndex += 1) {
    const file = files[fileIndex]
    scannedFiles += 1
    const normalizedFilePaths = [file.filePath, file.relativePath]
      .filter((path): path is string => typeof path === "string")
      .map(normalize)
    const matchesDiagnostic = normalizedFilePaths.some((path) => paths.some((diagnostic) => matchesPath(path, diagnostic.normalized)))
    const probe = probeApplyPatchCopyText(file, APPLY_PATCH_SCAN_LIMIT - scannedCharacters)
    scannedCharacters += probe.scanned
    if (probe.hasContent || probe.truncated || matchesDiagnostic) {
      rendered.push(file)
      knownPaths.push(...normalizedFilePaths)
    }
    if (scannedFiles >= 10_000) break
  }
  for (const path of paths) {
    if (rendered.length >= limit) break
    if (!knownPaths.some((knownPath) => matchesPath(knownPath, path.normalized))) {
      rendered.push({ filePath: path.raw })
      knownPaths.push(path.normalized)
    }
  }
  return {
    files: rendered,
    truncated: scannedFiles < files.length || diagnosticPathsTruncated,
  }
}
