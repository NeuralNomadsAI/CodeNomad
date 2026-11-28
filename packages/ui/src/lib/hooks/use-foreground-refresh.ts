import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { backendEvents as serverEvents } from "../server-events"
import { createForegroundRefreshController } from "./foreground-refresh-controller"

const log = getLogger("foreground-refresh")

interface ForegroundRefreshOptions {
  onRefresh: (backendId: string, signal: AbortSignal) => void | Promise<void>
}

// On mobile, backgrounding the app suspends JS execution and the SSE
// connection eventually times out (commonly ~45s). Events that would have
// arrived while suspended -- a tool call finishing, a message completing --
// are lost, and the UI can appear stuck as "running" even though the work
// actually finished on the server.
//
// The reliable signal that this happened is the SSE transport's
// disconnected -> connected transition, not visibilitychange itself: a brief
// tab switch where the connection stays alive should NOT force a reload
// (that was tried first and it cleared in-flight "sending" state, making it
// look like the AI never responded -- see git history on this hook).
// Only once we know events were actually missed do we re-fetch session
// status and force-reload messages to surface whatever completed while
// disconnected.
export function useForegroundRefresh(options: ForegroundRefreshOptions): void {
  onMount(() => {
    const controllers = new Map<string, { authority: AbortSignal; controller: ReturnType<typeof createForegroundRefreshController> }>()
    const controllerFor = (backendId: string, authority: AbortSignal) => {
      const existing = controllers.get(backendId)
      if (existing?.authority === authority) return existing.controller
      existing?.controller.dispose()
      const controller = createForegroundRefreshController(
        async signal => {
          signal.throwIfAborted()
          log.info("SSE transport reconnected - refreshing session state")
          await options.onRefresh(backendId, signal)
          signal.throwIfAborted()
          log.info("Foreground refresh complete")
        },
        {
          signal: authority,
          onError: (error) => log.error("Foreground refresh failed - retrying while connected", error),
        },
      )
      controllers.set(backendId, { controller, authority })
      return controller
    }
    const unsubscribe = serverEvents.onTransportStatus((status, backendId) => {
      const authority = serverEvents.signal(backendId)
      if (!authority) return
      if (status === "disconnected") {
        log.info("SSE transport disconnected — will refresh on reconnect")
      }
      controllerFor(backendId, authority).handle(status)
    })
    const removed = serverEvents.onDetach((backendId, signal) => {
      if (controllers.get(backendId)?.authority !== signal) return
      controllers.get(backendId)?.controller.dispose()
      controllers.delete(backendId)
    })
    onCleanup(() => {
      controllers.forEach(({ controller }) => controller.dispose())
      unsubscribe()
      removed()
    })
  })
}
