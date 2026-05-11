export interface DesktopEventTransportReconnectPolicy {
  initialDelayMs: number
  maxDelayMs: number
  multiplier: number
  maxAttempts?: number
}

export interface DesktopEventTransportStartOptions {
  reconnect?: Partial<DesktopEventTransportReconnectPolicy>
}

export type DesktopEventTransportState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "unauthorized"
  | "error"
  | "stopped"

export interface DesktopEventTransportStats {
  rawEvents: number
  emittedEvents: number
  emittedBatches: number
  deltaCoalesces: number
  snapshotCoalesces: number
  statusCoalesces: number
  supersededDeltasDropped: number
}

export interface DesktopEventTransportStatusPayload {
  generation: number
  state: DesktopEventTransportState
  reconnectAttempt: number
  terminal: boolean
  reason?: string
  nextDelayMs?: number
  statusCode?: number
  stats?: DesktopEventTransportStats
}

export interface DesktopEventsStartResult {
  started: boolean
  generation?: number
  reason?: string
}

export interface DesktopEventActiveSessionTarget {
  instanceId: string
  sessionId: string
}

export interface AssistantStreamChunkEvent {
  type: "assistant.stream.chunk"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: "text"
    delta: string
  }
}

export const DEFAULT_DESKTOP_EVENT_RECONNECT_POLICY: DesktopEventTransportReconnectPolicy = {
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  multiplier: 2,
}

export function resolveDesktopEventTransportStartOptions(
  options?: DesktopEventTransportStartOptions,
): Required<DesktopEventTransportStartOptions> {
  return {
    reconnect: {
      ...DEFAULT_DESKTOP_EVENT_RECONNECT_POLICY,
      ...options?.reconnect,
    },
  }
}
