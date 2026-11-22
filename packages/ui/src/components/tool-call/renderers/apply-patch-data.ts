export type ApplyPatchFile = {
  file?: string
  filePath?: string
  relativePath?: string
  status?: string
  diff?: string
  patch?: string
}

export function getApplyPatchFiles(metadata: Record<string, unknown>): ApplyPatchFile[] {
  return Array.isArray(metadata.files) ? metadata.files : []
}

export function getApplyPatchFilePath(file: ApplyPatchFile): string | undefined {
  if (typeof file?.filePath === "string") return file.filePath
  return typeof file?.file === "string" ? file.file : undefined
}

export const APPLY_PATCH_FILE_RENDER_LIMIT = 20
const APPLY_PATCH_SCAN_LIMIT = 10_000

const operationCodes = { added: "A", deleted: "D", modified: "M", renamed: "R" } as const

export function getApplyPatchFileChange(file: ApplyPatchFile, directory?: string): { status?: keyof typeof operationCodes; path: string } {
  const root = directory?.replace(/\\/g, "/").replace(/\/?$/, "/")
  const windows = root && /^(?:[a-z]:\/|\/\/)/i.test(root)
  const comparable = (path: string) => windows ? path.toLowerCase() : path
  const relative = (path: string) => {
    const normalized = path.replace(/\\/g, "/")
    return root && comparable(normalized).startsWith(comparable(root)) ? normalized.slice(root.length) : normalized
  }
  const target = relative(file?.relativePath || getApplyPatchFilePath(file) || "")
  const nativeStatus = file?.status
  const status = nativeStatus === "added" || nativeStatus === "deleted" || nativeStatus === "modified" || nativeStatus === "renamed"
    ? nativeStatus
    : undefined
  // V2 names the destination in `file`; its same-path diff headers still name the source.
  if (target && (status === "renamed" || (status === "modified" && typeof file.file === "string"))) {
    const header = getApplyPatchDiff(file).slice(0, APPLY_PATCH_SCAN_LIMIT).split(/\r?\n@@ /, 1)[0]
    const sourcePath = /^Index: (.+)\r?$/m.exec(header)?.[1] ?? /^--- ([^\t\r\n]+)\r?$/m.exec(header)?.[1]
    if (sourcePath) {
      const source = relative(sourcePath)
      if (source !== target && (status === "renamed" || directory || !source.endsWith(`/${target}`))) {
        return { status: "renamed", path: `${source} → ${target}` }
      }
    }
  }
  return { status, path: target }
}

export function* getApplyPatchDiagnosticPaths(diagnostics: Record<string, unknown>): Generator<string> {
  for (const path in diagnostics) if (Object.prototype.hasOwnProperty.call(diagnostics, path)) yield path
}

export function getApplyPatchDiff(file: ApplyPatchFile): string {
  return typeof file?.diff === "string" ? file.diff : typeof file?.patch === "string" ? file.patch : ""
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

export function getApplyPatchFileCopyText(file: ApplyPatchFile, directory?: string): string {
  const { status, path } = getApplyPatchFileChange(file, directory)
  const diff = getApplyPatchDiff(file)
  return status && path ? `${operationCodes[status]} ${path}${diff ? `\n${diff}` : ""}` : diff
}

export function getApplyPatchCopyAccess(files: ApplyPatchFile[], fallback: string | null, directory?: string) {
  if (hasApplyPatchCopyText(files)) {
    const getCopyText = () => files.map((file) => getApplyPatchFileCopyText(file, directory)).filter((text) => text.trim()).join("\n") || fallback
    return { language: "diff" as const, getCopyText, hasCopyText: true as const }
  }
  if (typeof fallback !== "string" || fallback.length === 0) return undefined
  return { language: "text" as const, getCopyText: () => fallback, hasCopyText: true as const }
}

/**
 * Files to render within a shared character budget. Each rendered file carries its
 * whole diff and the share of the budget it renders before its own in-place reveal;
 * `truncated` reports files (or content) omitted from rendering altogether.
 */
export function getApplyPatchRenderData(files: ApplyPatchFile[], fileLimit: number, characterLimit: number, sourceTruncated = false) {
  const rendered: Array<{ file: ApplyPatchFile; diffText: string; renderLimit: number }> = []
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
    const diffText = firstContent >= 0 ? fullDiff.slice(firstContent) : ""
    rendered.push({ file, diffText, renderLimit: remaining })
    characters += Math.min(diffText.length, remaining)
    // Content the bounded scan could not locate cannot be revealed in place.
    if (probe.truncated && !probe.hasContent) truncated = true
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
    const normalizedFilePaths = [getApplyPatchFilePath(file), file?.relativePath]
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
