import type { Attachment, FileSource } from "../types/attachment"

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  const fileAttachments = new Set(
    attachments
      .filter((a): a is Attachment & { source: FileSource } => a.source.type === "file")
      .map((a) => a.source.path),
  )

  const pathAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "text" && typeof a.display === "string" && a.display.startsWith("path:"))
      .map((a) => (a.source as { value: string }).value),
  )

  let result = prompt

  // Step 1: Handle root paths FIRST using unique placeholders
  // Replace longer pattern first to avoid partial match issues
  result = result.replace(/@(\.\/)/g, "___ROOT___")
  result = result.replace(/@(\.)(?!\.)/g, "___ROOT_NOSLASH___")
  // Note: The regex @(\.)(?!\.) means @. NOT followed by another .

  // Step 2: Build set of non-root paths
  const allPaths = new Set<string>()
  for (const p of fileAttachments) {
    if (p && p !== "." && p !== "./") allPaths.add(p)
  }
  for (const p of pathAttachments) {
    if (p && p !== "." && p !== "./") allPaths.add(p)
  }

  // Step 3: Replace @path with ./path for non-root paths
  for (const path of allPaths) {
    if (!path) continue
    const withoutPrefix = path.startsWith("./") ? path.slice(2) : path
    const withPrefix = path.startsWith("./") ? path : "./" + path
    result = result.replace("@" + withoutPrefix, withPrefix)
    result = result.replace("@" + withoutPrefix + "/", withPrefix + "/")
  }

  // Step 4: Convert placeholders back to ./
  result = result.replace("___ROOT___", "./")
  result = result.replace("___ROOT_NOSLASH___", "./")

  // Step 5: Resolve [pasted #N] placeholders
  if (!result.includes("[pasted #")) {
    return result
  }

  if (!attachments || attachments.length === 0) {
    return result
  }

  const lookup = new Map<string, string>()

  for (const attachment of attachments) {
    const source = attachment?.source
    if (!source || source.type !== "text") continue
    const display = attachment?.display
    const value = (source as { value?: string }).value
    if (typeof display !== "string" || typeof value !== "string") continue
    const match = display.match(/pasted #(\d+)/)
    if (!match) continue
    const placeholder = `[pasted #${match[1]}]`
    if (!lookup.has(placeholder)) {
      lookup.set(placeholder, value)
    }
  }

  if (lookup.size === 0) {
    return result
  }

  return result.replace(/\[pasted #(\d+)\]/g, (fullMatch) => {
    const replacement = lookup.get(fullMatch)
    return typeof replacement === "string" ? replacement : fullMatch
  })
}
