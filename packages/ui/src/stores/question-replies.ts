// Structural mirror of permission-replies.ts for the question request lifecycle.
// Intentionally NOT a shared permissions+questions abstraction (YAGNI): prune
// semantics may diverge between the two request types, and ~40 lines of
// duplication is acceptable per the architect's binding constraints.
const repliedQuestionIdsByInstance = new Map<string, Map<string, number>>()

function pruneRepliedQuestions(instanceId: string, remotePendingIds: Set<string>, syncStartedAt: number): void {
  const replied = repliedQuestionIdsByInstance.get(instanceId)
  if (!replied) return
  for (const [questionId, repliedAt] of replied) {
    // Only a sync started after the local reply can prove the server no longer
    // considers this question pending.
    if (!remotePendingIds.has(questionId) && syncStartedAt >= repliedAt) {
      replied.delete(questionId)
    }
  }
  if (replied.size === 0) {
    repliedQuestionIdsByInstance.delete(instanceId)
  }
}

function markQuestionReplied(instanceId: string, questionId: string, repliedAt = Date.now()): void {
  if (!questionId) return
  let replied = repliedQuestionIdsByInstance.get(instanceId)
  if (!replied) {
    replied = new Map()
    repliedQuestionIdsByInstance.set(instanceId, replied)
  }
  replied.set(questionId, repliedAt)
}

function hasRepliedQuestion(instanceId: string, questionId: string): boolean {
  const replied = repliedQuestionIdsByInstance.get(instanceId)
  if (!replied) return false
  return replied.has(questionId)
}

function clearRepliedQuestions(instanceId: string): void {
  repliedQuestionIdsByInstance.delete(instanceId)
}

export { clearRepliedQuestions, hasRepliedQuestion, markQuestionReplied, pruneRepliedQuestions }
