import { createBackendRegistry } from "./backend-registry"
import { preferences, preferencesForBackend } from "./preferences"
import { isPreferencesWindow } from "../lib/runtime-env"

/** One registry per renderer, shared by future remote consumers. Importing it only observes policy. */
export const backendRegistry = createBackendRegistry({
  enabled: () => preferences().multiBackend,
  profiles: () => preferencesForBackend("local").remoteServers(),
  loadWorkspaces: async (client, signal) => {
    if (isPreferencesWindow()) return
    const { refreshWorkspaceList } = await import("./instances")
    if (!signal.aborted) await refreshWorkspaceList(client.id, client.api, signal)
  },
})
