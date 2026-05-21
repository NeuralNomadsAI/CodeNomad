import { resolvePastedPlaceholders } from "../../lib/prompt-placeholders"
import type { Attachment } from "../../types/attachment"

export type PromptSubmissionMode = "message" | "shell" | "slash"

export interface PromptSubmissionResult {
  historyEntry: string
  submitPrompt: string
  resolvedCommandArgs: string
}

export function preparePromptSubmission(input: {
  mode: PromptSubmissionMode
  text: string
  attachments: Attachment[]
  commandToken?: string
  commandArgs?: string
}): PromptSubmissionResult {
  const attachments = input.attachments ?? []

  if (input.mode === "slash") {
    const resolvedCommandArgs = resolvePastedPlaceholders(input.commandArgs ?? "", attachments)
    const historyEntry = resolvedCommandArgs ? `${input.commandToken ?? ""} ${resolvedCommandArgs}` : (input.commandToken ?? "")
    return {
      historyEntry,
      submitPrompt: historyEntry,
      resolvedCommandArgs,
    }
  }

  const resolvedPrompt = resolvePastedPlaceholders(input.text, attachments)

  if (input.mode === "message") {
    return {
      historyEntry: resolvedPrompt,
      submitPrompt: input.text,
      resolvedCommandArgs: "",
    }
  }

  return {
    historyEntry: resolvedPrompt,
    submitPrompt: resolvedPrompt,
    resolvedCommandArgs: "",
  }
}
