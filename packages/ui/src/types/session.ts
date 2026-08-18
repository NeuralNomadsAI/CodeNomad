import type {
  AgentInfo as SDKAgent,
  LocationRef,
  ModelInfo as SDKModel,
  ProviderInfo as SDKProvider,
  SessionInfo as SDKSession,
  SessionStatus as SDKSessionStatus,
} from "@opencode-ai/client"
import type { GenerationRecoveryState } from "../stores/session-generation-recovery"

// Export SDK types for external use
export type {
  AgentInfo as SDKAgent,
  ModelInfo as SDKModel,
  ProviderInfo as SDKProvider,
  SessionInfo as SDKSession,
} from "@opencode-ai/client"

export type SessionStatus = "idle" | "working" | "compacting"

export interface SessionRetryState {
  attempt: number
  message: string
  next: number
}

export function getIdleSinceForStatusTransition(
  previousStatus: SessionStatus | null | undefined,
  nextStatus: SessionStatus,
  previousIdleSince: number | null | undefined,
  now = Date.now(),
): number | null {
  if (nextStatus !== "idle") {
    return null
  }

  if (previousStatus && previousStatus !== "idle") {
    return now
  }

  return previousIdleSince ?? null
}

export function mapSdkSessionStatus(status: SDKSessionStatus | null | undefined): SessionStatus {
  if (!status || status.type === "idle") {
    return "idle"
  }

  // "busy" and "retry" both mean there's active work.
  return "working"
}

export function mapSdkSessionRetry(status: SDKSessionStatus | null | undefined): SessionRetryState | null {
  if (!status || status.type !== "retry") {
    return null
  }

  return {
    attempt: typeof status.attempt === "number" ? status.attempt : 1,
    message: typeof status.message === "string" ? status.message : "",
    next: typeof status.next === "number" ? status.next : Date.now(),
  }
}

// Our client-specific Session interface extending SDK Session
export interface Session extends Omit<SDKSession, "parentID" | "model"> {
  instanceId: string // Client-specific field
  parentId: string | null // Client-specific field (override parentID)
  agent: string // Client-specific field
  model: {
    providerId: string
    modelId: string
  }
  location: LocationRef
  version?: string
  pendingPermission?: boolean // Indicates if session is waiting on user permission
  pendingQuestion?: boolean // Indicates if session is waiting on user input
  pendingForm?: boolean // Indicates if session is waiting on a structured form response
  status: SessionStatus // Single source of truth for session status
  retry?: SessionRetryState | null // Retry metadata for transient backoff states
  idleSince?: number | null // Timestamp set when work finished but the session has not been viewed yet
  generationRecovery?: GenerationRecoveryState | null // Local recovery state for work interrupted across restarts
  runtimeStatusKnown?: boolean // Whether idle/working came from an authoritative runtime response
  generationAdmissionToken?: number // Guards recovery state while a new input is being admitted
  metadata?: Record<string, unknown> // CodeNomad-local runtime state; V2 SessionInfo does not persist this
}

// Adapter function to convert SDK Session to client Session
export function createClientSession(
  sdkSession: SDKSession,
  instanceId: string,
  agent: string = "",
  model: { providerId: string; modelId: string } = { providerId: "", modelId: "" },
  status: SessionStatus = "idle",
): Session {
  return {
    ...sdkSession,
    instanceId,
    parentId: sdkSession.parentID || null,
    agent,
    model,
    status,
    idleSince: null,
    generationRecovery: null,
    runtimeStatusKnown: false,
  }
}

// No type guard needed - we control the API and know the exact types we receive

// Our client-specific Agent interface (simplified version of SDK Agent)
export interface Agent {
  id: string
  name: string
  description: string
  mode: string
  hidden?: boolean
  model?: {
    providerId: string
    modelId: string
  }
}

/**
 * Matches OpenCode TUI's primary-agent visibility rule: visible iff not a subagent and not hidden.
 */
export function isSelectablePrimaryAgent(agent: Agent): boolean {
  return !agent.hidden && agent.mode !== "subagent"
}

export function findAgentById(agentList: Agent[], agentId: string): Agent | undefined {
  return agentList.find((agent) => agent.id === agentId)
}

export function resolveAgentId(agentList: Agent[], value: string): string {
  const exact = findAgentById(agentList, value)
  if (exact) return exact.id
  const legacyMatches = agentList.filter((agent) => agent.name === value)
  return legacyMatches.length === 1 ? legacyMatches[0].id : value
}

export function getSelectableAgentsForSession(
  agentList: Agent[],
  currentAgentId: string,
  isChildSession: boolean,
): Agent[] {
  if (!isChildSession) {
    return agentList.filter(isSelectablePrimaryAgent)
  }

  const visibleAgents = agentList.filter((agent) => !agent.hidden)
  const currentHiddenAgent = agentList.find((agent) => agent.hidden && agent.id === currentAgentId)

  return currentHiddenAgent && !visibleAgents.some((agent) => agent.id === currentHiddenAgent.id)
    ? [...visibleAgents, currentHiddenAgent]
    : visibleAgents
}

// Our client-specific Provider interface (simplified version of SDK Provider)
export interface Provider {
  id: string
  name: string
  models: Model[]
  defaultModelId?: string
}

// Our client-specific Model interface (simplified version of SDK Model)
export interface Model {
  id: string
  name: string
  providerId: string
  variantKeys?: string[]
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
  }
}
