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
  onPrivateOwner?: (payload: unknown) => void
  onPrivateEvent?: (payload: unknown) => void
  onReset?: () => void
  logger: EventSourceLogger
}

export function attachEventSourceHandlers(source: EventSource, options: EventSourceHandlerOptions) {
  let disconnected = false
  let closed = false
  source.addEventListener("open", () => { if (!closed) { disconnected = false; options.onReset?.() } })
  for (const [name, callback] of [["codenomad.bundles.owner", options.onPrivateOwner],
    ["codenomad.bundles.event", options.onPrivateEvent]] as const) {
    source.addEventListener(name, (event: MessageEvent) => {
      if (disconnected) return
      try { callback?.(JSON.parse(event.data)) } catch { /* Private data stays outside diagnostics. */ }
    })
  }
  const close = source.close.bind(source)
  source.close = () => { options.onReset?.(); disconnected = true; closed = true; close() }

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
    options.onReset?.()
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
