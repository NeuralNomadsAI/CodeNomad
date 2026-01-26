import { createSignal } from "solid-js"
import toast from "solid-toast"
import type { UpdateCheckResult, WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverEvents } from "../lib/server-events"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("update-checker")

const [updateStatus, setUpdateStatus] = createSignal<UpdateCheckResult | null>(null)
const [isChecking, setIsChecking] = createSignal(false)

let initialized = false

/**
 * Initialize the update checker store.
 * Listens for app.updateAvailable events from the server and fetches initial status.
 */
export function initUpdateChecker() {
  if (initialized) {
    return
  }
  initialized = true

  // Listen for update available events from the server
  serverEvents.on("app.updateAvailable", (event) => {
    const typedEvent = event as Extract<WorkspaceEventPayload, { type: "app.updateAvailable" }>
    applyUpdateResult(typedEvent.updates, true)
  })

  // Fetch initial status on startup
  void fetchUpdateStatus()
}

/**
 * Apply an update check result, optionally showing a toast notification.
 */
function applyUpdateResult(result: UpdateCheckResult | null, showToast: boolean) {
  if (!result) {
    setUpdateStatus(null)
    return
  }

  setUpdateStatus(result)

  // Show toast notification if updates are available
  if (showToast) {
    const hasEraCodeUpdate = result.eraCode?.available ?? false
    const hasOpenCodeUpdate = result.openCode?.available ?? false

    if (hasEraCodeUpdate || hasOpenCodeUpdate) {
      const updates: string[] = []
      if (hasEraCodeUpdate && result.eraCode?.targetVersion) {
        updates.push(`Era Code ${result.eraCode.targetVersion}`)
      }
      if (hasOpenCodeUpdate && result.openCode?.latestVersion) {
        updates.push(`OpenCode ${result.openCode.latestVersion}`)
      }

      toast.success(`Updates available: ${updates.join(", ")}`, {
        duration: 8000,
        position: "top-right",
      })
    }
  }
}

/**
 * Fetch the current update status from the server without triggering a new check.
 */
async function fetchUpdateStatus() {
  try {
    const response = await serverApi.getUpdateStatus()
    if (response && "eraCode" in response) {
      applyUpdateResult(response, false)
    }
  } catch (error) {
    log.warn("Failed to fetch update status", error)
  }
}

/**
 * Manually trigger an update check.
 * Returns the update check result.
 */
export async function triggerUpdateCheck(): Promise<UpdateCheckResult | null> {
  if (isChecking()) {
    return null
  }

  setIsChecking(true)
  try {
    const result = await serverApi.checkForUpdates()
    if (result && "eraCode" in result) {
      applyUpdateResult(result, true)
      return result
    }
    return null
  } catch (error) {
    log.error("Update check failed", error)
    toast.error("Failed to check for updates")
    return null
  } finally {
    setIsChecking(false)
  }
}

/**
 * Check if there's an Era Code update available.
 */
export function hasEraCodeUpdate(): boolean {
  return updateStatus()?.eraCode?.available ?? false
}

/**
 * Check if there's an OpenCode update available.
 */
export function hasOpenCodeUpdate(): boolean {
  return updateStatus()?.openCode?.available ?? false
}

/**
 * Get the full update status signal.
 */
export function useUpdateStatus() {
  return updateStatus
}

/**
 * Get whether an update check is in progress.
 */
export function useIsCheckingUpdates() {
  return isChecking
}

/**
 * Format the last checked time as a relative string.
 */
export function formatLastChecked(): string | null {
  const status = updateStatus()
  if (!status?.lastChecked) {
    return null
  }

  const now = Date.now()
  const diff = now - status.lastChecked
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) {
    return "Just now"
  } else if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  } else if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`
  } else {
    return `${days} day${days === 1 ? "" : "s"} ago`
  }
}
