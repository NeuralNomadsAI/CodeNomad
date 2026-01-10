import type {
  QuestionRequest,
  EventQuestionReplied,
  EventQuestionRejected,
} from "@opencode-ai/sdk/v2"

export type { QuestionRequest }

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
  properties: EventQuestionReplied["properties"] | EventQuestionRejected["properties"] | null | undefined,
): string | undefined {
  return properties?.requestID
}
