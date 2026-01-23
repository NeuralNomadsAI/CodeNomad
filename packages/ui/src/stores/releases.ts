import { createSignal } from "solid-js"
import type { LatestReleaseInfo, WorkspaceEventPayload } from "../../../server/src/api-types"
import { getServerMeta } from "../lib/server-meta"
import { serverEvents } from "../lib/server-events"
import { getLogger } from "../lib/logger"

const log = getLogger("actions")

const [availableRelease, setAvailableRelease] = createSignal<LatestReleaseInfo | null>(null)

let initialized = false

export function initReleaseNotifications() {
  if (initialized) {
    return
  }
  initialized = true

  void refreshFromMeta()

  serverEvents.on("app.releaseAvailable", (event) => {
    const typedEvent = event as Extract<WorkspaceEventPayload, { type: "app.releaseAvailable" }>
    applyRelease(typedEvent.release)
  })
}

async function refreshFromMeta() {
  try {
    const meta = await getServerMeta(true)
    if (meta.latestRelease) {
      applyRelease(meta.latestRelease)
    }
  } catch (error) {
    log.warn("Unable to load server metadata for release info", error)
  }
}

function applyRelease(release: LatestReleaseInfo | null | undefined) {
  if (!release) {
    setAvailableRelease(null)
    return
  }
  setAvailableRelease(release)
}

export function useAvailableRelease() {
  return availableRelease
}
