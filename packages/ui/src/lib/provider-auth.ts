import type { FormAnswer, FormField, FormFields, FormValue, IntegrationKeyMethod } from "@opencode-ai/client"

export type ProviderAuthAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export const genericApiMethod: IntegrationKeyMethod = { type: "key", label: "" }

export function isProviderAuthHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function matchesStringFormat(value: string, format: Extract<FormField, { type: "string" }>["format"]): boolean {
  if (!format) return true
  if (format === "uri") {
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  }
  if (format === "email") return /^[^\s@]+@[^\s@]+$/.test(value)
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) && !Number.isNaN(Date.parse(value))
}

export function extractProviderAuthErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as {
    data?: { message?: unknown }
    message?: unknown
    error?: { data?: { message?: unknown }; message?: unknown }
  }
  const nested = candidate?.error
  const message = candidate?.data?.message ?? nested?.data?.message ?? candidate?.message ?? nested?.message
  return typeof message === "string" && message.trim().length > 0 ? message : fallback
}

export function getProviderAuthInitialAnswer(fields?: FormFields): FormAnswer {
  const answer: FormAnswer = {}
  for (const field of fields ?? []) {
    if (field.type !== "external" && field.default !== undefined) answer[field.key] = field.default
  }
  return answer
}

export function shouldShowProviderAuthField(field: FormField, answer: FormAnswer): boolean {
  if (field.type === "external") return true
  return (field.when ?? []).every((condition) => {
    const actual = answer[condition.key]
    if (actual === undefined) return false
    const matches = Array.isArray(actual) ? actual.includes(String(condition.value)) : actual === condition.value
    return condition.op === "eq" ? matches : !matches
  })
}

export function getProviderAuthAnswer(fields: FormFields | undefined, values: FormAnswer): FormAnswer | undefined {
  if (!fields) return undefined
  return Object.fromEntries(
    fields
      .filter((field) => field.type !== "external" && shouldShowProviderAuthField(field, values))
      .flatMap((field) => values[field.key] === undefined ? [] : [[field.key, values[field.key] as FormValue]]),
  )
}

export function isProviderAuthFieldComplete(field: FormField, answer: FormAnswer): boolean {
  if (field.type === "external") return true
  const value = answer[field.key]
  if (value === undefined) return !field.required

  if (field.type === "string") {
    if (typeof value !== "string" || (field.required && value.trim().length === 0)) return false
    if (field.minLength !== undefined && value.length < field.minLength) return false
    if (field.maxLength !== undefined && value.length > field.maxLength) return false
    if (!matchesStringFormat(value, field.format)) return false
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) return false
    if (field.pattern) {
      try {
        if (!new RegExp(`^(?:${field.pattern})$`).test(value)) return false
      } catch {
        return false
      }
    }
    return true
  }

  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false
    if (field.type === "integer" && !Number.isInteger(value)) return false
    if (typeof field.minimum === "number" && value < field.minimum) return false
    if (typeof field.maximum === "number" && value > field.maximum) return false
    return true
  }

  if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false
    if (field.required && value.length === 0) return false
    if (field.minItems !== undefined && value.length < field.minItems) return false
    if (field.maxItems !== undefined && value.length > field.maxItems) return false
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) return false
    return true
  }

  return typeof value === "boolean"
}

export function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate?.name === "AbortError" || candidate?.message === "This operation was aborted"
}
