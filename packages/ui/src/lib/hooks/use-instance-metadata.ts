import type { LocationRef } from "@opencode-ai/client"
import type { Instance } from "../../types/instance"
import { getLogger } from "../../lib/logger"
import { getInstanceMetadata, getInstanceMetadataGeneration, mergeInstanceMetadata } from "../../stores/instance-metadata"
import { waitForPluginActivation } from "../../stores/plugin-activation"
import { toRequestLocation } from "../../stores/request-locations"

const log = getLogger("session")
const pendingMetadataRequests = new Map<string, {
  client: NonNullable<Instance["client"]>
  generation: number
  locationKey: string
  promise: Promise<void>
}>()
const pendingProjectMetadataRequests = new Map<string, {
  client: NonNullable<Instance["client"]>
  generation: number
  promise: Promise<void>
}>()

function locationKey(location: LocationRef): string {
  return `${location.directory}\0${location.workspaceID ?? ""}`
}

function metadataMatchesLocation(metadata: Instance["metadata"] | undefined, location: LocationRef): boolean {
  if (!metadata) return false
  const resolved = metadata.mcpStatus?.location
  return resolved?.directory === location.directory
    && (!location.workspaceID || resolved.workspaceID === location.workspaceID)
}

function hasMetadataLoaded(metadata?: Instance["metadata"], location?: LocationRef): boolean {
  if (!metadata) return false
  if (metadata.project === undefined || metadata.mcpStatus === undefined || metadata.plugins === undefined) return false
  return !location || metadataMatchesLocation(metadata, location)
}

export function loadInstanceMetadata(instance: Instance, options?: { force?: boolean; location?: LocationRef }): Promise<void> {
  const client = instance.client
  if (!client) {
    log.warn("[metadata] Skipping fetch; client missing", { instanceId: instance.id })
    return Promise.resolve()
  }

  const location = options?.location ?? { directory: instance.folder }
  const currentLocationKey = locationKey(location)
  const currentMetadata = getInstanceMetadata(instance.id) ?? instance.metadata
  if (!options?.force && hasMetadataLoaded(currentMetadata, location)) {
    return Promise.resolve()
  }

  const generation = getInstanceMetadataGeneration(instance.id)
  const pending = pendingMetadataRequests.get(instance.id)
  if (pending?.client === client
    && pending.generation === generation
    && pending.locationKey === currentLocationKey) return pending.promise
  const request = { client, generation, locationKey: currentLocationKey, promise: Promise.resolve() as Promise<void> }
  request.promise = (async () => {
    try {
      const requestLocation = toRequestLocation(location)
      const pluginRequest = waitForPluginActivation(client, location)
        .then(() => client.plugin.list({ location: requestLocation }))
      const [projectResult, projectsResult, mcpResult, pluginResult] = await Promise.allSettled([
        loadInstanceProjectMetadata(instance, options),
        client.project.list(),
        client.mcp.list({ location: requestLocation }),
        pluginRequest,
      ])

      const currentProject = getInstanceMetadata(instance.id)?.project
      const listedProject = currentProject && projectsResult.status === "fulfilled"
        ? projectsResult.value.find((project) => project.id === currentProject.id)
        : undefined
      const plugins = pluginResult.status === "fulfilled"
        ? pluginResult.value.data.flatMap((plugin) => {
            const status = plugin.state?.status ?? (plugin as unknown as { status?: string }).status
            return status === "active" && typeof plugin.id === "string" && !plugin.id.startsWith("opencode.")
              ? [plugin.id]
              : []
          })
        : undefined

      const latestMetadata = getInstanceMetadata(instance.id) ?? currentMetadata
      const updates: Instance["metadata"] = { ...(latestMetadata ?? {}) }
      if (latestMetadata && !metadataMatchesLocation(latestMetadata, location)) {
        updates.mcpStatus = undefined
        updates.plugins = undefined
      }

      if (projectResult.status === "fulfilled" && currentProject && listedProject?.vcs) {
        updates.project = { ...currentProject, vcs: listedProject.vcs }
      }

      if (mcpResult.status === "fulfilled") {
        updates.mcpStatus = mcpResult.value
      }

      if (pluginResult.status === "fulfilled") {
        updates.plugins = plugins ?? []
      }

      if (!updates?.version && instance.binaryVersion) {
        updates.version = instance.binaryVersion
      }


      if (pendingMetadataRequests.get(instance.id) !== request
        || getInstanceMetadataGeneration(instance.id) !== generation) return
      mergeInstanceMetadata(instance.id, updates)
    } catch (error) {
      log.error("Failed to load instance metadata", error)
    } finally {
      if (pendingMetadataRequests.get(instance.id) === request) pendingMetadataRequests.delete(instance.id)
    }
  })()
  pendingMetadataRequests.set(instance.id, request)
  return request.promise
}

export function loadInstanceProjectMetadata(instance: Instance, options?: { force?: boolean }): Promise<void> {
  const client = instance.client
  if (!client) return Promise.resolve()
  const currentMetadata = getInstanceMetadata(instance.id) ?? instance.metadata
  if (!options?.force && currentMetadata && "project" in currentMetadata) return Promise.resolve()

  const generation = getInstanceMetadataGeneration(instance.id)
  const pending = pendingProjectMetadataRequests.get(instance.id)
  if (pending?.client === client && pending.generation === generation) return pending.promise
  const request = { client, generation, promise: Promise.resolve() as Promise<void> }
  request.promise = client.project.current({ location: { directory: instance.folder } })
    .then((project) => {
      if (pendingProjectMetadataRequests.get(instance.id) !== request
        || getInstanceMetadataGeneration(instance.id) !== generation) return
      mergeInstanceMetadata(instance.id, {
        project: project ?? null,
        ...(!currentMetadata?.version && instance.binaryVersion ? { version: instance.binaryVersion } : {}),
      })
    })
    .catch((error) => log.warn("Failed to load project metadata", { instanceId: instance.id, error }))
    .finally(() => {
      if (pendingProjectMetadataRequests.get(instance.id) === request) pendingProjectMetadataRequests.delete(instance.id)
    })
  pendingProjectMetadataRequests.set(instance.id, request)
  return request.promise
}

export { hasMetadataLoaded }


