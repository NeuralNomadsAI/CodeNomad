import { getCacheEntry } from "./global-cache"

export interface UiBootstrapConfig {
  theme?: "light" | "dark" | "system"
  locale?: string
}

const UI_BOOTSTRAP_CACHE_ENTRY = {
  scope: "ui-bootstrap",
  cacheId: "ui-config",
  version: "1",
} as const

export function readUiBootstrapConfig(): UiBootstrapConfig {
  return getCacheEntry<UiBootstrapConfig>(UI_BOOTSTRAP_CACHE_ENTRY) ?? {}
}

export function getUiBootstrapCacheEntry() {
  return UI_BOOTSTRAP_CACHE_ENTRY
}
