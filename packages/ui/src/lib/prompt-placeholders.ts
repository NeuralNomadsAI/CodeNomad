import type { Attachment } from "../types/attachment"

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  // First, strip @ from file/directory paths that don't have file attachments
  // This handles SHIFT+ENTER case where @path should become path
  // Only apply to path-like tokens (containing /), not regular @mentions
  const fileAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "file" && "path" in a.source)
      .map((a) => (a.source as { path: string }).path),
  )

  // Build a set of paths that were added via SHIFT+ENTER (text attachments with path: display)
  const pathAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "text" && typeof a.display === "string" && a.display.startsWith("path:"))
      .map((a) => (a.source as { value: string }).value),
  )

  let result = prompt.replace(/@([^\s@/]+(?:\/[^\s@/]+)*\/?)/g, (match, path) => {
    // Only strip @ from path-like tokens (containing / or ending with /)
    const normalizedPath = path.replace(/\/$/, "")

    // If this path has a file attachment (ENTER case), keep the @ (attachment is sent separately)
    if (fileAttachments.has(path) || fileAttachments.has(normalizedPath)) {
      return match
    }

    // If this path was added via SHIFT+ENTER (text attachment with path:), strip the @
    if (pathAttachments.has(normalizedPath) || pathAttachments.has(path)) {
      return normalizedPath
    }

    // Check if it looks like an email (contains @ and . but no /)
    // Keep @ for emails like test@email.com
    const atIndex = match.indexOf("@")
    const hasDotAfterAt = normalizedPath.includes(".")
    if (hasDotAfterAt && !normalizedPath.includes("/")) {
      return match
    }

    // Otherwise strip the @
    return normalizedPath
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
