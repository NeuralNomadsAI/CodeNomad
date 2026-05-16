/**
 * Decide whether an inline question prompt should be interactive.
 *
 * The legacy `activeInterruption` signal in `instances.ts` and the v2 store's
 * `state.questions.active` field used to disagree about which question owned
 * the focus, which produced the "options render but cannot be clicked" bug
 * tracked in tasks 058 / 059.
 *
 * This helper now derives the answer from the v2 store only:
 *   - The question must be the head of the v2 question queue
 *     (`questionsActiveRequestId === request.id`).
 *   - No permission interruption may be ahead of the question
 *     (`permissionsActiveId == null`).
 *
 * Keeping the rule pure makes it cheap to unit test and removes any
 * dependency on the legacy `activeInterruption` signal for the inline
 * `<QuestionToolBlock>`.
 */
export interface QuestionActiveInput {
  /** Question request id rendered by the inline block. */
  requestId: string | null | undefined
  /** `state.questions.active?.request.id` from the v2 message store. */
  questionsActiveRequestId: string | null | undefined
  /** `state.permissions.active?.permission.id` from the v2 message store. */
  permissionsActiveId: string | null | undefined
}

export function isInlineQuestionActive(input: QuestionActiveInput): boolean {
  if (!input.requestId) return false
  if (input.permissionsActiveId) return false
  return input.questionsActiveRequestId === input.requestId
}
