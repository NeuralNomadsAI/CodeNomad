export interface PendingRequestEntryLike {
  messageId?: string
  partId?: string
  enqueuedAt: number
}

export interface PendingRequestSkipInput {
  existing: PendingRequestEntryLike | undefined
  existingAtLocationId: string | undefined
  expectedActiveId: string | undefined
  activeId: string | undefined
  incomingId: string
  incomingMessageId: string | undefined
  incomingPartId: string | undefined
  incomingEnqueuedAt: number
  existingValue: unknown
  incomingValue: unknown
}

export function areStructuredValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export function mergePendingRequestEntry<T extends PendingRequestEntryLike>(entry: T, existing: T | undefined): T {
  if (!existing) return entry
  return {
    ...entry,
    messageId: entry.messageId ?? existing.messageId,
    partId: entry.partId ?? existing.partId,
    enqueuedAt: Math.min(existing.enqueuedAt, entry.enqueuedAt),
  }
}

export function shouldSkipPendingRequestUpsert(input: PendingRequestSkipInput): boolean {
  const existing = input.existing
  return Boolean(
    existing &&
    input.existingAtLocationId === input.incomingId &&
    input.activeId === input.expectedActiveId &&
    existing.messageId === input.incomingMessageId &&
    existing.partId === input.incomingPartId &&
    existing.enqueuedAt === input.incomingEnqueuedAt &&
    areStructuredValuesEqual(input.existingValue, input.incomingValue),
  )
}
