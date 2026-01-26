export function mergeMessageParts(...parts: Array<Record<string, string>>) {
  const result: Record<string, string> = {}

  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in result) {
        throw new Error(`Duplicate i18n message key: ${key}`)
      }
      result[key] = value
    }
  }

  return result
}
