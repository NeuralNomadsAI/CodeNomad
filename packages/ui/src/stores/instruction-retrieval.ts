/**
 * Instruction Retrieval Store
 *
 * Signal-based store managing per-session retrieval state.
 * Instructions are fetched from the server at session start and on tool
 * invocation, then injected as a hidden text part into `requestParts`
 * (not shown to the user in the chat UI).
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

async function fetchFlush(sessionId: string): Promise<{ flushed: boolean }> {
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/retrieval/flush`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  })
  if (!resp.ok) throw new Error(`retrieval/flush ${resp.status}`)
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

  // Session-start instructions (inject once)
  if (state.sessionStartComposed && !state.injectedSessionStart) {
    parts.push(state.sessionStartComposed)
  }

  // Tool instructions (inject once per tool)
  for (const [tool, composed] of state.toolComposed) {
    if (composed && !state.injectedTools.has(tool)) {
      parts.push(composed)
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

  return parts.join("\n")
}

/**
 * Flush access counts to the server and clear local state.
 */
export async function flushSession(instanceId: string, sessionId: string): Promise<void> {
  try {
    await fetchFlush(sessionId)
    log.info("Session flushed", { sessionId })
  } catch (err) {
    log.warn("Failed to flush session", { sessionId, error: err })
  } finally {
    clearRetrievalState(instanceId, sessionId)
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
