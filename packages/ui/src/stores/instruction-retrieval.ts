/**
 * Instruction Retrieval Store
 *
 * Signal-based store managing per-session retrieval state.
 * Instructions are fetched from the server at session start and on tool
 * invocation, then injected as a hidden text part into `requestParts`
 * (not shown to the user in the chat UI).
 *
 * Includes:
 * - Access counting with server-side persistence (ERA-713)
 * - Event bus for retrieval notifications (ERA-714)
 *
 * Follows the instruction-capture.ts signal pattern.
 */
import { createSignal } from "solid-js"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("instruction-retrieval")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievedInstruction {
  id: string
  content: string
  category: string | null
  scope: string
  score: number
  accessCount: number
  createdAt?: string
}

export interface RetrievalContext {
  projectName?: string
  language?: string
  activeTools?: string[]
  activeDirectives?: string[]
}

export interface FeedbackResult {
  promoted: boolean
  accessCount: number
  feedbackScore: number
}

export interface PromotionCandidate extends RetrievedInstruction {}

interface SessionRetrievalState {
  sessionStartInstructions: RetrievedInstruction[]
  sessionStartComposed: string
  toolInstructions: Map<string, RetrievedInstruction[]>
  toolComposed: Map<string, string>
  injectedSessionStart: boolean
  injectedTools: Set<string>
  fetchingSessionStart: boolean
}

// ---------------------------------------------------------------------------
// Event Bus (ERA-714)
// ---------------------------------------------------------------------------

export type RetrievalEventType = "instruction:retrieved" | "instruction:injected" | "instruction:promoted"

export interface RetrievalEvent {
  type: RetrievalEventType
  sessionId: string
  instanceId: string
  instructions?: RetrievedInstruction[]
  toolName?: string
  promotionCandidateIds?: string[]
  timestamp: number
}

type RetrievalEventListener = (event: RetrievalEvent) => void

const eventListeners = new Set<RetrievalEventListener>()

function emitRetrievalEvent(event: RetrievalEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event)
    } catch (err) {
      log.warn("Retrieval event listener error", { error: err })
    }
  }
}

export function onRetrievalEvent(listener: RetrievalEventListener): void {
  eventListeners.add(listener)
}

export function offRetrievalEvent(listener: RetrievalEventListener): void {
  eventListeners.delete(listener)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function createEmptyState(): SessionRetrievalState {
  return {
    sessionStartInstructions: [],
    sessionStartComposed: "",
    toolInstructions: new Map(),
    toolComposed: new Map(),
    injectedSessionStart: false,
    injectedTools: new Set(),
    fetchingSessionStart: false,
  }
}

const [retrievalState, setRetrievalState] = createSignal<Map<string, SessionRetrievalState>>(new Map())

function stateKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function getOrCreateSessionState(instanceId: string, sessionId: string): SessionRetrievalState {
  const key = stateKey(instanceId, sessionId)
  const current = retrievalState().get(key)
  if (current) return current

  const fresh = createEmptyState()
  setRetrievalState((prev) => {
    const next = new Map(prev)
    next.set(key, fresh)
    return next
  })
  return fresh
}

function updateSessionState(instanceId: string, sessionId: string, updater: (state: SessionRetrievalState) => void): void {
  const key = stateKey(instanceId, sessionId)
  setRetrievalState((prev) => {
    const next = new Map(prev)
    const state = next.get(key) ?? createEmptyState()
    updater(state)
    next.set(key, state)
    return next
  })
}

// ---------------------------------------------------------------------------
// Server Calls
// ---------------------------------------------------------------------------

async function fetchSessionStart(sessionId: string, context: RetrievalContext): Promise<{
  instructions: RetrievedInstruction[]
  composed: string
}> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, context }),
  })
  if (!resp.ok) throw new Error(`retrieval/session-start ${resp.status}`)
  return resp.json()
}

async function fetchToolInstructions(sessionId: string, toolName: string, context: RetrievalContext): Promise<{
  instructions: RetrievedInstruction[]
  composed: string
}> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, toolName, context }),
  })
  if (!resp.ok) throw new Error(`retrieval/tool ${resp.status}`)
  return resp.json()
}

async function fetchFlush(sessionId: string): Promise<{
  flushed: boolean
  count: number
  promotionCandidates: string[]
}> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/flush`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  })
  if (!resp.ok) throw new Error(`retrieval/flush ${resp.status}`)
  return resp.json()
}

async function fetchFeedback(
  sessionId: string,
  instructionId: string,
  outcome: "success" | "failure" | "dismissed",
): Promise<FeedbackResult> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, instructionId, outcome }),
  })
  if (!resp.ok) throw new Error(`retrieval/feedback ${resp.status}`)
  return resp.json()
}

async function fetchPromotionCandidates(): Promise<{ candidates: PromotionCandidate[] }> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/promotion-candidates`)
  if (!resp.ok) throw new Error(`retrieval/promotion-candidates ${resp.status}`)
  return resp.json()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve instructions for the start of a session.
 * Caches the result — subsequent calls for the same session are no-ops.
 */
export async function retrieveSessionStartInstructions(
  instanceId: string,
  sessionId: string,
  context: RetrievalContext,
): Promise<void> {
  const state = getOrCreateSessionState(instanceId, sessionId)

  // Already fetched or in-flight
  if (state.sessionStartInstructions.length > 0 || state.fetchingSessionStart) return

  updateSessionState(instanceId, sessionId, (s) => {
    s.fetchingSessionStart = true
  })

  try {
    const result = await fetchSessionStart(sessionId, context)
    updateSessionState(instanceId, sessionId, (s) => {
      s.sessionStartInstructions = result.instructions
      s.sessionStartComposed = result.composed
      s.fetchingSessionStart = false
    })
    log.info("Session-start instructions retrieved", {
      sessionId,
      count: result.instructions.length,
    })

    // Emit retrieval event (ERA-714)
    if (result.instructions.length > 0) {
      emitRetrievalEvent({
        type: "instruction:retrieved",
        sessionId,
        instanceId,
        instructions: result.instructions,
        timestamp: Date.now(),
      })
    }
  } catch (err) {
    updateSessionState(instanceId, sessionId, (s) => {
      s.fetchingSessionStart = false
    })
    log.warn("Failed to retrieve session-start instructions", { error: err })
  }
}

/**
 * Retrieve tool-specific instructions when a tool is invoked.
 * Each tool is only queried once per session (server-side cooldown
 * is also enforced).
 */
export async function retrieveToolInstructions(
  instanceId: string,
  sessionId: string,
  toolName: string,
  context: RetrievalContext,
): Promise<void> {
  const state = getOrCreateSessionState(instanceId, sessionId)

  // Per-tool cooldown on client side
  if (state.toolInstructions.has(toolName)) return

  try {
    const result = await fetchToolInstructions(sessionId, toolName, context)
    updateSessionState(instanceId, sessionId, (s) => {
      s.toolInstructions.set(toolName, result.instructions)
      s.toolComposed.set(toolName, result.composed)
    })
    log.info("Tool instructions retrieved", {
      sessionId,
      toolName,
      count: result.instructions.length,
    })

    // Emit retrieval event (ERA-714)
    if (result.instructions.length > 0) {
      emitRetrievalEvent({
        type: "instruction:retrieved",
        sessionId,
        instanceId,
        instructions: result.instructions,
        toolName,
        timestamp: Date.now(),
      })
    }
  } catch (err) {
    // Mark as queried even on failure to avoid retry storms
    updateSessionState(instanceId, sessionId, (s) => {
      s.toolInstructions.set(toolName, [])
      s.toolComposed.set(toolName, "")
    })
    log.warn("Failed to retrieve tool instructions", { toolName, error: err })
  }
}

/**
 * Get un-injected instructions as composed markdown, then mark them
 * as injected (one-shot). Returns `""` if nothing new to inject.
 */
export function getComposedInjection(instanceId: string, sessionId: string): string {
  const key = stateKey(instanceId, sessionId)
  const state = retrievalState().get(key)
  if (!state) return ""

  const parts: string[] = []
  const injectedInstructions: RetrievedInstruction[] = []

  // Session-start instructions (inject once)
  if (state.sessionStartComposed && !state.injectedSessionStart) {
    parts.push(state.sessionStartComposed)
    injectedInstructions.push(...state.sessionStartInstructions)
  }

  // Tool instructions (inject once per tool)
  for (const [tool, composed] of state.toolComposed) {
    if (composed && !state.injectedTools.has(tool)) {
      parts.push(composed)
      const toolInsts = state.toolInstructions.get(tool)
      if (toolInsts) injectedInstructions.push(...toolInsts)
    }
  }

  if (parts.length === 0) return ""

  // Mark as injected
  updateSessionState(instanceId, sessionId, (s) => {
    if (s.sessionStartComposed) {
      s.injectedSessionStart = true
    }
    for (const [tool, composed] of s.toolComposed) {
      if (composed) {
        s.injectedTools.add(tool)
      }
    }
  })

  // Emit injection event (ERA-714)
  if (injectedInstructions.length > 0) {
    emitRetrievalEvent({
      type: "instruction:injected",
      sessionId,
      instanceId,
      instructions: injectedInstructions,
      timestamp: Date.now(),
    })
  }

  return parts.join("\n")
}

/**
 * Flush access counts to the server and clear local state.
 * Returns any promotion candidates identified during flush.
 */
export async function flushSession(instanceId: string, sessionId: string): Promise<void> {
  try {
    const result = await fetchFlush(sessionId)
    log.info("Session flushed", { sessionId, count: result.count })

    // Emit promotion event if candidates found (ERA-714)
    if (result.promotionCandidates && result.promotionCandidates.length > 0) {
      emitRetrievalEvent({
        type: "instruction:promoted",
        sessionId,
        instanceId,
        promotionCandidateIds: result.promotionCandidates,
        timestamp: Date.now(),
      })
    }
  } catch (err) {
    log.warn("Failed to flush session", { sessionId, error: err })
  } finally {
    clearRetrievalState(instanceId, sessionId)
  }
}

/**
 * Record feedback for a retrieved instruction.
 * Returns whether the instruction should be promoted to a directive.
 */
export async function recordInstructionFeedback(
  instanceId: string,
  sessionId: string,
  instructionId: string,
  outcome: "success" | "failure" | "dismissed",
): Promise<FeedbackResult> {
  try {
    const result = await fetchFeedback(sessionId, instructionId, outcome)
    log.info("Feedback recorded", { sessionId, instructionId, outcome, promoted: result.promoted })

    if (result.promoted) {
      emitRetrievalEvent({
        type: "instruction:promoted",
        sessionId,
        instanceId,
        promotionCandidateIds: [instructionId],
        timestamp: Date.now(),
      })
    }

    return result
  } catch (err) {
    log.warn("Failed to record feedback", { instructionId, outcome, error: err })
    return { promoted: false, accessCount: 0, feedbackScore: 0 }
  }
}

/**
 * Query promotion candidates from the server.
 */
export async function getPromotionCandidates(): Promise<PromotionCandidate[]> {
  try {
    const result = await fetchPromotionCandidates()
    return result.candidates
  } catch (err) {
    log.warn("Failed to get promotion candidates", { error: err })
    return []
  }
}

/**
 * Clear local retrieval state for a session (no server call).
 */
export function clearRetrievalState(instanceId: string, sessionId: string): void {
  const key = stateKey(instanceId, sessionId)
  setRetrievalState((prev) => {
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

/**
 * Raw signal accessor for tests.
 */
export function getRetrievalState(): Map<string, SessionRetrievalState> {
  return retrievalState()
}
