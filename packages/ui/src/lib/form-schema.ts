import type { FormField, FormValue } from "@opencode-ai/client"

export function isFormFieldVisible(
  field: FormField,
  values: Record<string, FormValue | undefined>,
): boolean {
  if (field.type === "external" || !field.when?.length) return true
  return field.when.every((condition) => {
    const value = values[condition.key]
    if (value === undefined) return false
    const equal = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
    return condition.op === "eq" ? equal : !equal
  })
}

export function isHttpFormUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}
