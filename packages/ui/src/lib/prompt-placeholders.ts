import type { Attachment } from "../types/attachment"

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  // First, strip `@` from path-like mentions that do NOT have a backing file attachment.
  // This is intended for SHIFT+ENTER selection where we keep `@path` in the textarea for
  // easy deletion, but send `path` to the API.
  //
  // IMPORTANT: avoid rewriting plain `@mentions` or email addresses.
  const fileAttachmentPaths = new Set(
    attachments
      .filter((a) => a.source.type === "file")
      .map((a) => a.source.path),
  )

  const isPathLike = (value: string) => {
    if (!value) return false
    if (value.includes("/") || value.includes("\\")) return true
    if (value.startsWith("./") || value.startsWith("../")) return true
    if (value.startsWith("~")) return true
    if (value.endsWith("/")) return true

    // Root-level files (no `/`) still commonly have an extension.
    const ext = value.split(".").pop()?.toLowerCase()
    if (!ext || ext === value.toLowerCase()) return false

    // Keep this list intentionally small and code-focused to avoid matching domains like `example.com`.
    const allowedExts = new Set([
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "json",
      "md",
      "txt",
      "yml",
      "yaml",
      "toml",
      "css",
      "html",
      "htm",
      "svg",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "pdf",
      "rs",
      "go",
      "py",
      "java",
      "kt",
      "swift",
      "sh",
      "bash",
      "zsh",
      "sql",
      "lock",
    ])
    return allowedExts.has(ext)
  }

  const stripTrailingPunctuation = (value: string) => {
    const match = value.match(/^(.*?)([)\]}.,!?:;]+)?$/)
    if (!match) return { core: value, trailing: "" }
    return { core: match[1] ?? value, trailing: match[2] ?? "" }
  }

  let result = prompt.replace(/(^|[\s([{"'`])@([^\s@]+)/g, (full, prefix, rawToken) => {
    const { core, trailing } = stripTrailingPunctuation(String(rawToken))
    if (!core) return full

    // If this path has a file attachment, keep the `@` (attachment is sent separately).
    if (fileAttachmentPaths.has(core) || fileAttachmentPaths.has(core.replace(/\/$/, ""))) {
      return `${prefix}@${core}${trailing}`
    }

    // Only strip for path-like tokens; leave plain `@mentions` intact.
    if (!isPathLike(core)) {
      return `${prefix}@${core}${trailing}`
    }

    return `${prefix}${core}${trailing}`
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
