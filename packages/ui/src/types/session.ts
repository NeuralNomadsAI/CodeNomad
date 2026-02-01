import type {
  Session as SDKSession,
  Agent as SDKAgent,
  Provider as SDKProvider,
  Model as SDKModel,
  SessionStatus as SDKSessionStatus,
} from "@opencode-ai/sdk"

// Export SDK types for external use
export type { 
  Session as SDKSession,
  Agent as SDKAgent, 
  Provider as SDKProvider,
  Model as SDKModel
} from "@opencode-ai/sdk"

export type SessionStatus = "idle" | "working" | "compacting"

// Map SDK session status to our simplified status
export function mapSdkSessionStatus(
  status: SDKSessionStatus | null | undefined
): SessionStatus {
  if (!status || status.type === "idle") return "idle"
  return "working" // "busy" and "retry" both mean working
}

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
  status: SessionStatus // Session activity status (idle/working/compacting)
  pendingPermission?: boolean // Indicates if session is waiting on user permission
}

// Adapter function to convert SDK Session to client Session
export function createClientSession(
  sdkSession: import("@opencode-ai/sdk").Session,
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
  reasoning?: boolean
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
  }
}
