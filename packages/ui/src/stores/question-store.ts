/**
 * Question store: tracks pending question requests from the OpenCode "question" tool.
 *
 * OpenCode emits `question.asked` SSE events when the LLM calls the `question` tool.
 * The web UI must render the question inline and reply via POST /question/{id}/reply.
 */
import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"

const log = getLogger("question-store")

/** Matches the OpenCode Question.Option schema */
export interface QuestionOption {
  label: string
  description: string
}

/** Matches the OpenCode Question.Info schema */
export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/** Matches the OpenCode Question.Request schema */
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: {
    messageID: string
    callID: string
  }
}

/** Answer for a single question: array of selected labels / custom text */
export type QuestionAnswer = string[]

// Map<instanceId, Map<sessionId, QuestionRequest[]>>
const [questionRequests, setQuestionRequests] = createSignal<Map<string, Map<string, QuestionRequest[]>>>(new Map())

export function getQuestionRequests(instanceId: string, sessionId: string): QuestionRequest[] {
  return questionRequests().get(instanceId)?.get(sessionId) ?? []
}

export function getActiveQuestion(instanceId: string, sessionId: string): QuestionRequest | undefined {
  const requests = getQuestionRequests(instanceId, sessionId)
  return requests[0]
}

export function addQuestionRequest(instanceId: string, request: QuestionRequest): void {
  log.info("Adding question request", { instanceId, requestId: request.id, sessionId: request.sessionID })
  setQuestionRequests((prev) => {
    const next = new Map(prev)
    const instanceMap = new Map(next.get(instanceId) ?? new Map())
    const sessionRequests = [...(instanceMap.get(request.sessionID) ?? [])]

    // Avoid duplicates
    if (!sessionRequests.some((r) => r.id === request.id)) {
      sessionRequests.push(request)
    }

    instanceMap.set(request.sessionID, sessionRequests)
    next.set(instanceId, instanceMap)
    return next
  })
}

export function removeQuestionRequest(instanceId: string, sessionId: string, requestId: string): void {
  log.info("Removing question request", { instanceId, sessionId, requestId })
  setQuestionRequests((prev) => {
    const next = new Map(prev)
    const instanceMap = new Map(next.get(instanceId) ?? new Map())
    const sessionRequests = (instanceMap.get(sessionId) ?? []).filter((r: QuestionRequest) => r.id !== requestId)

    if (sessionRequests.length > 0) {
      instanceMap.set(sessionId, sessionRequests)
    } else {
      instanceMap.delete(sessionId)
    }

    next.set(instanceId, instanceMap)
    return next
  })
}

export { questionRequests }
