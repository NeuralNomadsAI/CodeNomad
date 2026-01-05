import type {
  Session as SDKSession,
  Agent as SDKAgent,
  Provider as SDKProvider,
  Model as SDKModel,
} from "@opencode-ai/sdk"

// Export SDK types for external use
export type { 
  Session as SDKSession,
  Agent as SDKAgent, 
  Provider as SDKProvider,
  Model as SDKModel
} from "@opencode-ai/sdk"

export type SessionStatus = "idle" | "working" | "compacting"

// Our client-specific Session interface extending SDK Session
export interface Session
  extends Omit<import("@opencode-ai/sdk").Session, "projectID" | "directory" | "parentID"> {
  instanceId: string // Client-specific field
  parentId: string | null // Client-specific field (override parentID)
  agent: string // Client-specific field
  model: {
    providerId: string
    modelId: string
  }
  version: string // Include version from SDK Session
  pendingPermission?: boolean // Indicates if session is waiting on user permission
  status: SessionStatus // Single source of truth for session status
}

// Adapter function to convert SDK Session to client Session
export function createClientSession(
  sdkSession: import("@opencode-ai/sdk").Session,
  instanceId: string,
  agent: string = "",
  model: { providerId: string; modelId: string } = { providerId: "", modelId: "" },
): Session {
  return {
    ...sdkSession,
    instanceId,
    parentId: sdkSession.parentID || null,
    agent,
    model,
    status: "idle",
  }
}

// No type guard needed - we control the API and know the exact types we receive

// Our client-specific Agent interface (simplified version of SDK Agent)
export interface Agent {
  name: string
  description: string
  mode: string
  model?: {
    providerId: string
    modelId: string
  }
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
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
  }
}
