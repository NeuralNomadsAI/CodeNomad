import { getToolName } from "../utils"

export function readSubagentName(input: Record<string, any>): string | undefined {
  if (typeof input.subagent_type === "string") return input.subagent_type
  if (typeof input.agent === "string") return input.agent
  return undefined
}

// `tool` is the raw tool name from the call ("task" or the V2 "subagent") so the
// title prefix matches the label the header strips.
export function describeTaskTitle(input: Record<string, any>, tool = "task") {
  const description = typeof input.description === "string" ? input.description : undefined
  const subagent = readSubagentName(input)
  const base = getToolName(tool)
  if (description && subagent) {
    return `${base}[${subagent}] ${description}`
  }
  if (description) {
    return `${base} ${description}`
  }
  return base
}
