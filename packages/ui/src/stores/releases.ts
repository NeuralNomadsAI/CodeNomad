import { createEffect, createSignal } from "solid-js"
import type { ServerMeta, SupportMeta } from "../../../server/src/api-types"
import { getServerMeta } from "../lib/server-meta"
import { showToastNotification, ToastHandle } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { tGlobal } from "../lib/i18n"
import { hasInstances, showFolderSelection } from "./ui"

const log = getLogger("actions")

const [supportInfo, setSupportInfo] = createSignal<SupportMeta | null>(null)

const UI_VERSION_STORAGE_KEY = "codenomad:lastSeenUiVersion"
const DEV_RELEASE_STORAGE_KEY = "codenomad:lastSeenDevRelease"
const META_REFRESH_INTERVAL_MS = 10 * 60 * 1000

let initialized = false
let visibilityEffectInitialized = false
let activeToast: ToastHandle | null = null
let activeToastKey: string | null = null
let uiUpdateToasted = false
let metaRefreshInterval: ReturnType<typeof setInterval> | null = null

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
    maybeNotifyUiUpdated(meta)
    maybeNotifyDevReleaseAvailable(meta)
    ensureMetaRefresh(meta)
  } catch (error) {
    log.warn("Unable to load server metadata for support info", error)
  }
}

export function useSupportInfo() {
  return supportInfo
}

function maybeNotifyUiUpdated(meta: ServerMeta) {
  if (uiUpdateToasted) return
  uiUpdateToasted = true

  const currentVersion = meta.ui?.version?.trim()
  if (!currentVersion) return

  const previousVersion = safeReadLocalStorage(UI_VERSION_STORAGE_KEY)
  safeWriteLocalStorage(UI_VERSION_STORAGE_KEY, currentVersion)

  if (!previousVersion) return
  if (previousVersion === currentVersion) return

  // Only show the "updated" toast when the server is serving a downloaded UI bundle.
  if (meta.ui?.source !== "downloaded") return
  if (!isSemverUpgrade(previousVersion, currentVersion)) return

  showToastNotification({
    title: tGlobal("releases.uiUpdated.title"),
    message: tGlobal("releases.uiUpdated.message", { version: currentVersion }),
    variant: "success",
    duration: 8000,
    position: "bottom-right",
  })
}

function maybeNotifyDevReleaseAvailable(meta: ServerMeta) {
  const update = meta.update
  if (!update || !update.version || !update.url) return

  const lastSeen = safeReadLocalStorage(DEV_RELEASE_STORAGE_KEY)
  if (lastSeen === update.version) {
    return
  }

  safeWriteLocalStorage(DEV_RELEASE_STORAGE_KEY, update.version)

  showToastNotification({
    title: tGlobal("releases.devUpdateAvailable.title"),
    message: tGlobal("releases.devUpdateAvailable.message", { version: update.version }),
    variant: "info",
    duration: 12000,
    position: "bottom-right",
    action: {
      label: tGlobal("releases.devUpdateAvailable.action"),
      href: update.url,
    },
  })
}

function ensureMetaRefresh(meta: ServerMeta) {
  if (metaRefreshInterval) return

  const version = meta.serverVersion?.trim() ?? ""
  const looksLikeDev = version.includes("-dev.") || version.includes("-dev-")
  const hasDevUpdateChannel = Boolean(meta.update)

  if (!looksLikeDev && !hasDevUpdateChannel) {
    return
  }

  metaRefreshInterval = setInterval(() => {
    void refreshFromMeta()
  }, META_REFRESH_INTERVAL_MS)
}

function safeReadLocalStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWriteLocalStorage(key: string, value: string) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function isSemverUpgrade(previous: string, current: string): boolean {
  const prevParsed = parseSemverCore(previous)
  const currParsed = parseSemverCore(current)
  if (!prevParsed || !currParsed) {
    // If either version isn't semver-like, default to "changed".
    return true
  }
  return compareSemverCore(currParsed, prevParsed) > 0
}

function compareSemverCore(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

function parseSemverCore(value: string): { major: number; minor: number; patch: number } | null {
  const core = value.trim().replace(/^v/i, "").split("-", 1)[0]
  if (!core) return null
  const parts = core.split(".")
  if (parts.length < 2) return null

  const parsePart = (input: string | undefined) => {
    const n = Number.parseInt((input ?? "0").replace(/[^0-9]/g, ""), 10)
    return Number.isFinite(n) ? n : 0
  }

  return {
    major: parsePart(parts[0]),
    minor: parsePart(parts[1]),
    patch: parsePart(parts[2]),
  }
}
