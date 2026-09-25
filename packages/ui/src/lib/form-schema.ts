import type { FormAnswer, FormField, FormFields, FormValue } from "@opencode/client"

export function isFormFieldVisible(
  field: FormField,
  values: Record<string, FormValue | undefined>,
): boolean {
  return (field.type === "external" || !field.hidden) && isFormFieldActive(field, values)
}

function isFormFieldActive(field: FormField, values: Record<string, FormValue | undefined>): boolean {
  if (field.type === "external" || !field.when?.length) return true
  return field.when.every((condition) => {
    const value = values[condition.key]
    if (value === undefined) return false
    const equal = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
    return condition.op === "eq" ? equal : !equal
  })
}

// Hidden fields still carry protocol data. Conditional/external fields do not.
// Share answer construction between session Forms and provider authentication.
export function getFormAnswer(fields: FormFields, values: Record<string, FormValue | undefined>): FormAnswer {
  return Object.fromEntries(fields.flatMap((field) => {
    if (field.type === "external" || !isFormFieldActive(field, values)) return []
    const value = values[field.key] ?? (field.hidden ? field.default : undefined)
    return value === undefined ? [] : [[field.key, value]]
  }))
}

export function isHttpFormUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}
