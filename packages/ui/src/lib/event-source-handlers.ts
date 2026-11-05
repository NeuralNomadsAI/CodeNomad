import type { WorkspaceEventPayload } from "../../../server/src/api-types"

type EventSourceLogger = {
  warn: (message: string) => void
  error: (message: string, error?: unknown) => void
}

type EventSourceWithClose = EventSource & {
  onclose?: () => void
}

interface EventSourceHandlerOptions {
  onEvent: (event: WorkspaceEventPayload) => void
  onError?: () => void
  onPing?: (payload: { ts?: number }) => void
  onParticipation?: (payload: unknown) => void
  logger: EventSourceLogger
}

export function attachEventSourceHandlers(source: EventSource, options: EventSourceHandlerOptions) {
  let disconnected = false

  source.onmessage = (event) => {
    let payload: WorkspaceEventPayload
    try {
      payload = JSON.parse(event.data) as WorkspaceEventPayload
    } catch {
      options.logger.error("Failed to parse event", { category: "invalid-event-json" })
      return
    }
    try {
      options.onEvent(payload)
    } catch {
      // Deferred reactive flush errors occur after individual subscribers have
      // returned. They are application failures, not malformed transport data.
      options.logger.error("Failed to dispatch event", { category: "event-dispatch-failed" })
    }
  }

  const handleDisconnect = (reason: string) => {
    if (disconnected) {
      return
    }
    disconnected = true
    options.logger.warn(reason)
    options.onError?.()
  }

  source.onerror = () => {
    handleDisconnect("EventSource error, closing stream")
  }

  ;(source as EventSourceWithClose).onclose = () => {
    handleDisconnect("EventSource closed")
  }

  source.addEventListener("close", () => {
    handleDisconnect("EventSource closed")
  })

  source.addEventListener("codenomad.client.ping", (event: MessageEvent) => {
    try {
      const payload = event.data ? (JSON.parse(event.data) as { ts?: number }) : {}
      options.onPing?.(payload)
    } catch {
      options.logger.error("Failed to parse ping event", { category: "invalid-ping-event" })
    }
  })
  source.addEventListener("codenomad.project.participation", (event: MessageEvent) => {
    if (disconnected || typeof event.data !== "string" || event.data.length > 256) return
    try { options.onParticipation?.(JSON.parse(event.data)) } catch { /* Private grants never enter diagnostics. */ }
  })
}
