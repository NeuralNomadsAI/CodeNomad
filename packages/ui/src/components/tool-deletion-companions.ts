type MessagePart = {
  type?: string
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
