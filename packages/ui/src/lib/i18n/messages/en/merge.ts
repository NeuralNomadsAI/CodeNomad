export type MessageCatalog = Record<string, string>

type MergeParts<Parts extends readonly MessageCatalog[]> = Parts extends readonly [
  infer Head extends MessageCatalog,
  ...infer Tail extends MessageCatalog[],
]
  ? Head & MergeParts<Tail>
  : {}

export function mergeMessageParts<const Parts extends readonly MessageCatalog[]>(
  ...parts: Parts
): MergeParts<Parts> {
  const result: Record<string, string> = Object.create(null)

  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in result) {
        throw new Error(`Duplicate i18n message key: ${key}`)
      }
      result[key] = value
    }
  }

  return result as MergeParts<Parts>
}
