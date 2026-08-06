import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { serverEvents } from "../server-events"

const log = getLogger("foreground-refresh")

// Module-level flag -- survives Solid reactive cycles, guaranteed not to reset
// between renders the way a component-local signal could.
let wasDisconnected = false

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
    const unsubscribe = serverEvents.onTransportStatus((status) => {
      if (status === "disconnected") {
        wasDisconnected = true
        log.info("SSE transport disconnected — will refresh on reconnect")
        return
      }

      if (status === "connected") {
        if (!wasDisconnected) {
          log.info("SSE connected but wasDisconnected=false — skipping refresh")
          return
        }
        wasDisconnected = false
        log.info("SSE transport reconnected — refreshing session state")
        void Promise.resolve(options.onRefresh())
          .then(() => {
            log.info("Foreground refresh complete")
          })
          .catch((error) => {
            log.error("Foreground refresh failed", error)
          })
      }
    })

    onCleanup(() => unsubscribe())
  })
}
