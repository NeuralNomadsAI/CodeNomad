import { createEffect } from "solid-js"
import { useGlobalCache } from "./hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import type { UiBootstrapConfig } from "./ui-config-bootstrap"

export function UiConfigBootstrapSync() {
  const { isLoaded, preferences, themePreference } = useConfig()
  const cache = useGlobalCache({
    scope: "ui-bootstrap",
    cacheId: "ui-config",
    version: "1",
  })

  createEffect(() => {
    if (!isLoaded()) {
      return
    }

    const next: UiBootstrapConfig = {
      theme: themePreference(),
      locale: preferences().locale,
    }

    cache.set(next)
  })

  return null
}
