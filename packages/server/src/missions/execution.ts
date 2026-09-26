import type { ModelRef } from "@opencode/client"

export interface MissionExecution {
  agent?: string
  model?: ModelRef
}

export const executionSchema = {
  type: "object",
  properties: {
    agent: { type: "string", minLength: 1, maxLength: 240 },
    model: {
      type: "object",
      properties: {
        providerID: { type: "string", minLength: 1, maxLength: 240 },
        id: { type: "string", minLength: 1, maxLength: 240 },
        variant: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["providerID", "id"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

export function parseExecution(input: unknown): MissionExecution | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid mission execution selection")
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => key !== "agent" && key !== "model")) throw new Error("Unknown execution field")
  const text = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 240) throw new Error("Invalid native execution identifier")
    return value
  }
  const agent = value.agent === undefined ? undefined : text(value.agent)
  if (value.model === undefined) return { agent }
  if (!value.model || typeof value.model !== "object" || Array.isArray(value.model)) throw new Error("Invalid model selection")
  const model = value.model as Record<string, unknown>
  if (Object.keys(model).some(key => !["providerID", "id", "variant"].includes(key))) throw new Error("Unknown model field")
  return { agent, model: {
    providerID: text(model.providerID), id: text(model.id),
    ...(model.variant === undefined ? {} : { variant: text(model.variant) }),
  } }
}

export function sameExecution(left?: MissionExecution, right?: MissionExecution): boolean {
  return left?.agent === right?.agent && left?.model?.providerID === right?.model?.providerID
    && left?.model?.id === right?.model?.id && left?.model?.variant === right?.model?.variant
}

export function matchesExecution(request: MissionExecution | undefined, actual: MissionExecution): boolean {
  return (!request?.agent || request.agent === actual.agent)
    && (!request?.model || sameExecution({ model: request.model }, { model: actual.model }))
}
