import type { FormInfo } from "@opencode/client"

// Specialize only the known native consent contract; future fields and custom
// provider forms keep the generic schema-driven form and its validation.
export function isWebSearchProviderForm(form: FormInfo): boolean {
  if (form.metadata?.kind !== "websearch.provider" || form.fields.length !== 1) return false
  const field = form.fields[0]
  if (field.type !== "string" || field.custom || field.hidden || !field.required || !field.options?.length) return false
  if (field.key === "provider") return true
  return field.key === "choice" && field.options.length === 3
    && ["allow", "choose", "disable"].every(value => field.options!.some(option => option.value === value))
}
