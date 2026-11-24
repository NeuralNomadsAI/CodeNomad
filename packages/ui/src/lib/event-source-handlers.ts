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
  logger: EventSourceLogger
}

export function attachEventSourceHandlers(source: EventSource, options: EventSourceHandlerOptions) {
  let disconnected = false

  source.onmessage = (event) => {
    let payload: WorkspaceEventPayload
    try {
      payload = JSON.parse(event.data) as WorkspaceEventPayload
    } catch (error) {
      options.logger.error("Failed to parse event", error)
      return
    }
    try {
      options.onEvent(payload)
    } catch (error) {
      // Deferred reactive flush errors occur after individual subscribers have
      // returned. They are application failures, not malformed transport data.
      options.logger.error("Failed to dispatch event", error)
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
    } catch (error) {
      options.logger.error("Failed to parse ping event", error)
    }
  })
}
