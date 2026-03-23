import { createEffect } from "solid-js"
import { useConfig } from "../stores/preferences"
import { writeUiBootstrapCache } from "./ui-bootstrap-cache"

export function UiBootstrapCacheSync() {
  const { isLoaded, preferences, themePreference } = useConfig()

  createEffect(() => {
    if (!isLoaded()) {
      return
    }

    writeUiBootstrapCache({
      theme: themePreference(),
      locale: preferences().locale ?? null,
    })
  })

  return null
}
