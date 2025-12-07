import { createEffect, createSignal } from "solid-js"
import type { LatestReleaseInfo, WorkspaceEventPayload } from "../../../server/src/api-types"
import { getServerMeta } from "../lib/server-meta"
import { serverEvents } from "../lib/server-events"
import { showToastNotification, ToastHandle } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { hasInstances, showFolderSelection } from "./ui"

const log = getLogger("actions")

const [availableRelease, setAvailableRelease] = createSignal<LatestReleaseInfo | null>(null)

let initialized = false
let visibilityEffectInitialized = false
let activeToast: ToastHandle | null = null
let activeToastVersion: string | null = null

function dismissActiveToast() {
  if (activeToast) {
    activeToast.dismiss()
    activeToast = null
    activeToastVersion = null
  }
}

function ensureVisibilityEffect() {
  if (visibilityEffectInitialized) {
    return
  }
  visibilityEffectInitialized = true

  createEffect(() => {
    const release = availableRelease()
    const shouldShow = Boolean(release) && (!hasInstances() || showFolderSelection())

    if (!shouldShow || !release) {
      dismissActiveToast()
      return
    }

    if (!activeToast || activeToastVersion !== release.version) {
      dismissActiveToast()
      activeToast = showToastNotification({
        title: `CodeNomad ${release.version}`,
        message: release.channel === "dev" ? "Dev release build available." : "New stable build on GitHub.",
        variant: "info",
        duration: Number.POSITIVE_INFINITY,
        position: "bottom-right",
        action: {
          label: "View release",
          href: release.url,
        },
      })
      activeToastVersion = release.version
    }
  })
}

export function initReleaseNotifications() {
  if (initialized) {
    return
  }
  initialized = true

  ensureVisibilityEffect()
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
