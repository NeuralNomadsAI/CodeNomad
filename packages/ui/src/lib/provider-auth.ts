export type ProviderAuthMethod = {
  type: "oauth" | "api"
  label: string
  prompts?: ProviderAuthPrompt[]
}

export type ProviderAuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      when?: ProviderAuthPromptCondition
    }
  | {
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      when?: ProviderAuthPromptCondition
    }

export type ProviderAuthPromptCondition = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type ProviderAuthAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export const genericApiMethod: ProviderAuthMethod = { type: "api", label: "" }

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

export function shouldShowProviderAuthPrompt(prompt: ProviderAuthPrompt, values: Record<string, string>): boolean {
  if (!prompt.when) return true
  const actual = values[prompt.when.key]
  if (actual === undefined) return false
  return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
}

export function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate?.name === "AbortError" || candidate?.message === "This operation was aborted"
}
