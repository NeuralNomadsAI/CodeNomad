import { createBackendRegistry } from "./backend-registry"
import { preferences, preferencesForBackend } from "./preferences"

/** One registry per renderer, shared by future remote consumers. Importing it only observes policy. */
export const backendRegistry = createBackendRegistry({
  enabled: () => preferences().multiBackend,
  profiles: () => preferencesForBackend("local").remoteServers(),
  loadWorkspaces: async (client, signal) => {
    const { refreshWorkspaceList } = await import("./instances")
    return !signal.aborted && refreshWorkspaceList(client.id, client.api, signal)
  },
})
