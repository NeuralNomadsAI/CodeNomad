import type {
  QuestionReplied,
  QuestionRejected,
  QuestionRequest as NativeQuestionRequest,
} from "@opencode-ai/client"

export type QuestionRequest = NativeQuestionRequest

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
  return question?.tool?.id
}

export function getRequestIdFromQuestionReply(
  data: QuestionReplied["data"] | QuestionRejected["data"] | null | undefined,
): string | undefined {
  return data?.requestID
}
