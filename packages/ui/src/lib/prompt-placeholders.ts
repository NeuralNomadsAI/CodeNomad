import type { Attachment, FileSource } from "../types/attachment"

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  // Get file attachments (ENTER case) - these are sent separately, keep @ in prompt
  const fileAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "file" && "path" in a.source)
      .map((a) => (a.source as { path: string }).path),
  )

  // Build a set of paths that were added via SHIFT+ENTER (text attachments with path: display)
  // These need @ stripped from the prompt
  const pathAttachments = new Set(
    attachments
      .filter((a) => a.source.type === "text" && typeof a.display === "string" && a.display.startsWith("path:"))
      .map((a) => (a.source as { value: string }).value),
  )

  let result = prompt

  // For each path attachment (SHIFT+ENTER), find and replace @path with path in the prompt
  // We ALWAYS strip @ for SHIFT+ENTER paths, even if there's also a file attachment
  for (const path of pathAttachments) {
    // Try both with and without trailing slash
    const variants = [path, path + "/"]

    for (const variant of variants) {
      // Replace @path with path (exact match)
      const searchPattern = "@" + variant
      result = result.split(searchPattern).join(variant)
    }
  }

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
