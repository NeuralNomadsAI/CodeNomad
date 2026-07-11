type MessagePart = {
  type?: string
}

export type MessagePartDeletionTarget = {
  messageId: string
  partId: string
}

export type BulkDeletionPlan = {
  messageIds: readonly string[]
  companionParts: readonly MessagePartDeletionTarget[]
  toolParts: readonly MessagePartDeletionTarget[]
}

type BulkDeletionActions = {
  clearSelection: () => void
  deleteMessage: (messageId: string) => Promise<void>
  deletePart: (target: MessagePartDeletionTarget) => Promise<void>
}

export async function executeBulkDeletionPlan(plan: BulkDeletionPlan, actions: BulkDeletionActions): Promise<void> {
  // Timeline segment IDs are positional, so stale selections must not survive
  // the first successful mutation and point at a different segment.
  actions.clearSelection()

  for (const messageId of plan.messageIds) {
    await actions.deleteMessage(messageId)
  }
  for (const target of plan.companionParts) {
    await actions.deletePart(target)
  }
  for (const target of plan.toolParts) {
    await actions.deletePart(target)
  }
}

export function collectToolDeletionCompanionPartIds(
  partIds: readonly string[],
  getPart: (partId: string) => MessagePart | undefined,
  selectedToolPartIds: ReadonlySet<string>,
): Set<string> {
  const companions = new Set<string>()
  let stepPartIds: string[] = []

  const flushStep = () => {
    const toolPartIds = stepPartIds.filter((partId) => getPart(partId)?.type === "tool")
    if (toolPartIds.length > 0 && toolPartIds.every((partId) => selectedToolPartIds.has(partId))) {
      for (const partId of stepPartIds) {
        const type = getPart(partId)?.type
        if (type === "reasoning" || type === "step-finish") {
          companions.add(partId)
        }
      }
    }
    stepPartIds = []
  }

  for (const partId of partIds) {
    const type = getPart(partId)?.type
    if (type === "step-start") {
      flushStep()
      continue
    }

    stepPartIds.push(partId)
    if (type === "step-finish") {
      flushStep()
    }
  }

  flushStep()
  return companions
}
