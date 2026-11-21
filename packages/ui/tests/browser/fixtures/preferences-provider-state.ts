import { createRoot } from "solid-js"
import { useImageSettings } from "../../../src/components/settings/useImageSettings"
import { useWebSearchSettings } from "../../../src/components/settings/useWebSearchSettings"

/** Observe the real settings hooks independently of the Preferences unavailable gate. */
export function observeProviderSettings(instanceId: string) {
  return createRoot(dispose => {
    const props = { instanceId, location: { directory: "/homonym" } }
    const image = useImageSettings(props), search = useWebSearchSettings(props)
    return {
      dispose,
      state: () => ({
        image: image.snapshot(), search: search.snapshot(),
        providers: search.providers(), integrations: search.integrations(),
        busy: image.busy() || search.busy(),
      }),
    }
  })
}
