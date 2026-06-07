import type {
  QuestionV2Request,
  EventQuestionV2Replied,
  EventQuestionV2Rejected,
} from "@opencode-ai/sdk/v2"

export type QuestionSource = "legacy" | "v2"

export type QuestionRequest = QuestionV2Request & {
  version?: string
}

export type LegacyQuestionAskedEvent = {
  type: "question.asked"
  properties?: QuestionRequest
}

export type LegacyQuestionAnsweredEvent = {
  type: "question.replied" | "question.rejected"
  properties?: { requestID?: string }
}

export function getQuestionId(question: QuestionRequest | null | undefined): string {
  return question?.id ?? ""
}

export function getQuestionSessionId(question: QuestionRequest | null | undefined): string | undefined {
  return question?.sessionID
}

export function getQuestionMessageId(question: QuestionRequest | null | undefined): string | undefined {
  return question?.tool?.messageID
}

export function getQuestionCallId(question: QuestionRequest | null | undefined): string | undefined {
  return question?.tool?.callID
}

export function getQuestionCreatedAt(question: QuestionRequest | null | undefined): number {
  // v2 schema doesn't include created time; best effort for ordering.
  return Date.now()
}

export function getRequestIdFromQuestionReply(
  properties: EventQuestionV2Replied["properties"] | EventQuestionV2Rejected["properties"] | LegacyQuestionAnsweredEvent["properties"] | null | undefined,
): string | undefined {
  return properties?.requestID
}
