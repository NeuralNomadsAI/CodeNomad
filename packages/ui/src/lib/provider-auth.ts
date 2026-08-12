import type { FormAnswer, FormField, FormFields, FormValue, IntegrationKeyMethod } from "@opencode-ai/client"

export type ProviderAuthAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export const genericApiMethod: IntegrationKeyMethod = { type: "key", label: "" }

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
  if (field.type === "external" || !field.required) return true
  const value = answer[field.key]
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined
}

export function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate?.name === "AbortError" || candidate?.message === "This operation was aborted"
}
