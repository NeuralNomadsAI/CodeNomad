import { resolvePastedPlaceholders } from "../../lib/prompt-placeholders"
import type { Attachment } from "../../types/attachment"

export type PromptSubmissionMode = "message" | "shell" | "slash"

export interface PromptSubmissionResult {
  historyEntry: string
  submitPrompt: string
  resolvedCommandArgs: string
}

export function isPromptDeliveryAmbiguous(error: unknown): boolean {
  return (error as any)?.suppressPromptRecovery === true
}

export function prepareFailedPromptRecovery(input: {
  submittedText: string
  submittedAttachments: Attachment[]
  currentText: string
  currentAttachments: Attachment[]
}): { text: string; attachments: Attachment[] } {
  const usedCounters = new Set<number>()
  for (const attachment of input.currentAttachments) {
    const match = attachment.display?.match(/^pasted #(\d+)/i)
    if (match) usedCounters.add(Number(match[1]))
  }
  const allocatedCounters = new Set(usedCounters)
  for (const attachment of input.submittedAttachments) {
    const match = attachment.display?.match(/^pasted #(\d+)/i)
    if (match) allocatedCounters.add(Number(match[1]))
  }

  const counterReplacements = new Map<number, number>()
  const recovered: Attachment[] = []
  for (const attachment of input.submittedAttachments) {
    if (input.currentAttachments.some((current) => current.id === attachment.id)) continue
    const match = attachment.display?.match(/^pasted #(\d+)/i)
    const originalCounter = match ? Number(match[1]) : undefined
    if (originalCounter === undefined || !usedCounters.has(originalCounter)) {
      if (originalCounter !== undefined) usedCounters.add(originalCounter)
      recovered.push(attachment)
      continue
    }

    let nextCounter = 1
    while (allocatedCounters.has(nextCounter)) nextCounter += 1
    usedCounters.add(nextCounter)
    allocatedCounters.add(nextCounter)
    counterReplacements.set(originalCounter, nextCounter)
    recovered.push({
      ...attachment,
      display: attachment.display?.replace(/^pasted #\d+/i, `pasted #${nextCounter}`),
    })
  }
  const submittedText = input.submittedText.replace(/\[pasted #(\d+)(?=[\]\s])/gi, (token, counter) => {
    const replacement = counterReplacements.get(Number(counter))
    return replacement === undefined ? token : `[pasted #${replacement}`
  })

  return {
    text: input.currentText ? `${submittedText}\n${input.currentText}` : submittedText,
    attachments: [...input.currentAttachments, ...recovered],
  }
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
