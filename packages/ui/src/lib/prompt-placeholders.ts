import type { Attachment } from "../types/attachment"

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  // First, strip @ from file/directory paths that don't have file attachments
  // This handles SHIFT+ENTER case where @path should become path
  const fileAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "file" && "path" in a.source)
      .map((a) => (a.source as { path: string }).path),
  )

  let result = prompt.replace(/@([^\s@]+)/g, (match, path) => {
    // If this path has a file attachment, keep the @ (attachment is sent separately)
    if (fileAttachments.has(path) || fileAttachments.has(path.replace(/\/$/, ""))) {
      return match
    }
    // Otherwise (SHIFT+ENTER case), strip the @
    return path
  })

  // Then, resolve [pasted #N] placeholders
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
    const value = source.value
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
