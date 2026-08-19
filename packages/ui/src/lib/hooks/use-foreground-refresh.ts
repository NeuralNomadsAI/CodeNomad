import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { serverEvents } from "../server-events"
import { createForegroundRefreshController } from "./foreground-refresh-controller"

const log = getLogger("foreground-refresh")

interface ForegroundRefreshOptions {
  onRefresh: () => void | Promise<void>
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
    const controller = createForegroundRefreshController(
      async () => {
        log.info("SSE transport reconnected — refreshing session state")
        await options.onRefresh()
        log.info("Foreground refresh complete")
      },
      {
        onError: (error) => log.error("Foreground refresh failed — retrying while connected", error),
      },
    )
    const unsubscribe = serverEvents.onTransportStatus((status) => {
      if (status === "disconnected") {
        log.info("SSE transport disconnected — will refresh on reconnect")
      }
      controller.handle(status)
    })
    onCleanup(() => {
      controller.dispose()
      unsubscribe()
    })
  })
}
