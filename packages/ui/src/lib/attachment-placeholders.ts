export type AttachmentPlaceholderKind = "image" | "pasted"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function createAttachmentPlaceholderRegex(
  kind: AttachmentPlaceholderKind,
  counter?: string | number,
  options: { global?: boolean } = {},
): RegExp {
  const label = kind === "image" ? "Image" : "pasted"
  const counterPattern = counter === undefined ? "(\\d+)" : escapeRegExp(String(counter))
  return new RegExp(`\\[\\s*${label}\\s*#\\s*${counterPattern}\\s*\\]`, options.global === false ? "i" : "gi")
}
