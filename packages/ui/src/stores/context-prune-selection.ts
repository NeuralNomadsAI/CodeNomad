import { createSignal } from "solid-js"

export interface ContextPruneSelectionCommand {
  sessionId: string
  indices: number[]
}

const [pendingCommands, setPendingCommands] = createSignal<Map<string, ContextPruneSelectionCommand>>(new Map())

export function stageContextPruneSelection(command: ContextPruneSelectionCommand): void {
  if (!command.sessionId) {
    throw new Error("Context prune selection requires a sessionId")
  }

  const normalizedIndices = Array.from(
    new Set(
      command.indices
        .map((value) => Math.trunc(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).sort((left, right) => left - right)

  if (normalizedIndices.length === 0) {
    throw new Error("Context prune selection requires at least one positive index")
  }

  setPendingCommands((prev) => {
    const next = new Map(prev)
    next.set(command.sessionId, {
      sessionId: command.sessionId,
      indices: normalizedIndices,
    })
    return next
  })
}

export function getPendingContextPruneSelection(sessionId: string): ContextPruneSelectionCommand | null {
  if (!sessionId) return null
  return pendingCommands().get(sessionId) ?? null
}

export function consumeContextPruneSelection(sessionId: string): ContextPruneSelectionCommand | null {
  if (!sessionId) return null
  const command = pendingCommands().get(sessionId) ?? null
  if (!command) return null

  setPendingCommands((prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Map(prev)
    next.delete(sessionId)
    return next
  })

  return command
}
