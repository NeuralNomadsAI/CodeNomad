export type AttachmentPlaceholderKind = "image" | "pasted"

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function getAttachmentPlaceholder(display: unknown) {
  if (typeof display !== "string" || display.length > 1024) return
  const match = display.match(/(pasted|image)\s*#\s*(\d+)/i)
  if (!match) return
  return {
    kind: match[1]!.toLowerCase() === "image" ? "image" as const : "pasted" as const,
    counter: match[2]!,
  }
}

export function createAttachmentPlaceholderRegex(
  kind: AttachmentPlaceholderKind,
  counter: string | number | undefined = undefined,
  options: { global?: boolean } = {},
): RegExp {
  const label = kind === "image" ? "Image" : "pasted"
  const count = counter === undefined ? "(\\d+)" : escapeRegExp(String(counter))
  return new RegExp(`\\[\\s*${label}\\s*#\\s*${count}\\s*\\]`, options.global === false ? "i" : "gi")
}
