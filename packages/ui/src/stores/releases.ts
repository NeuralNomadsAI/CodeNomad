import { createEffect, createSignal } from "solid-js"
import type { SupportMeta } from "../../../server/src/api-types"
import { getServerMeta } from "../lib/server-meta"
import { showToastNotification, ToastHandle } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { tGlobal } from "../lib/i18n"
import { hasInstances, showFolderSelection } from "./ui"

const log = getLogger("actions")

const [supportInfo, setSupportInfo] = createSignal<SupportMeta | null>(null)

let initialized = false
let visibilityEffectInitialized = false
let activeToast: ToastHandle | null = null
let activeToastKey: string | null = null

function dismissActiveToast() {
  if (activeToast) {
    activeToast.dismiss()
    activeToast = null
    activeToastKey = null
  }
}

function ensureVisibilityEffect() {
  if (visibilityEffectInitialized) {
    return
  }
  visibilityEffectInitialized = true

  createEffect(() => {
    const support = supportInfo()
    const shouldShow = Boolean(support && support.supported === false) && (!hasInstances() || showFolderSelection())

    if (!shouldShow || !support || support.supported !== false) {
      dismissActiveToast()
      return
    }

    const key = `${support.minServerVersion ?? "unknown"}:${support.latestServerVersion ?? "unknown"}`

    if (!activeToast || activeToastKey !== key) {
      dismissActiveToast()
      activeToast = showToastNotification({
        title: support.message ?? tGlobal("releases.upgradeRequired.title"),
        message: support.latestServerVersion
          ? tGlobal("releases.upgradeRequired.message.withVersion", { version: support.latestServerVersion })
          : tGlobal("releases.upgradeRequired.message.noVersion"),
        variant: "info",
        duration: Number.POSITIVE_INFINITY,
        position: "bottom-right",
        action: support.latestServerUrl
          ? {
              label: tGlobal("releases.upgradeRequired.action.getUpdate"),
              href: support.latestServerUrl,
            }
          : undefined,
      })
      activeToastKey = key
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
}

async function refreshFromMeta() {
  try {
    const meta = await getServerMeta(true)
    setSupportInfo(meta.support ?? null)
  } catch (error) {
    log.warn("Unable to load server metadata for support info", error)
  }
}

export function useSupportInfo() {
  return supportInfo
}
