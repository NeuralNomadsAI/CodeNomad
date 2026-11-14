import { createMemo } from "solid-js"
import { getActiveCatalogLocation } from "../stores/sessions"
import { activeSessionId, sessions } from "../stores/session-state"

/**
 * The Location the Plugins and integration surfaces of an instance manage (its active catalog Location, else its
 * folder) and the displayed conversation, only when that conversation belongs to this Location.
 */
export function createIntegrationContext(instanceId: () => string, folder: () => string) {
  const location = createMemo(() => getActiveCatalogLocation(instanceId()) ?? { directory: folder() })
  const session = createMemo(() => {
    const id = activeSessionId().get(instanceId())
    const session = id ? sessions().get(instanceId())?.get(id) : undefined
    return session?.location.directory === location().directory ? session : undefined
  })
  return { location, session }
}
