import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { serverEvents } from "../server-events"

const log = getLogger("foreground-refresh")

// Module-level flags -- survive Solid reactive cycles, guaranteed not to reset
// between renders the way a component-local signal could.
let wasDisconnected = false
let refreshInFlight = false

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
        // Do NOT clear the dirty latch yet: it must survive a failed refresh so
        // a subsequent reconnect retries. Guard against overlapping runs if
        // connected fires again while a refresh is still in flight.
        if (refreshInFlight) {
          log.info("Reconnect refresh already in flight — skipping duplicate")
          return
        }
        refreshInFlight = true
        log.info("SSE transport reconnected — refreshing session state")
        void Promise.resolve(options.onRefresh())
          .then(() => {
            // Clear the latch ONLY after a fully successful recovery.
            wasDisconnected = false
            log.info("Foreground refresh complete")
          })
          .catch((error) => {
            // Keep wasDisconnected=true so the next disconnected->connected
            // transition performs a bounded retry instead of silently
            // forgetting the missed events.
            log.error("Foreground refresh failed — will retry on next reconnect", error)
          })
          .finally(() => {
            refreshInFlight = false
          })
      }
    })

    onCleanup(() => unsubscribe())
  })
}
