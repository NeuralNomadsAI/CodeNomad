import type { Instance } from "../../types/instance"
import { getLogger } from "../../lib/logger"
import { getInstanceMetadata, getInstanceMetadataGeneration, mergeInstanceMetadata } from "../../stores/instance-metadata"

const log = getLogger("session")
const pendingMetadataRequests = new Map<string, {
  client: NonNullable<Instance["client"]>
  generation: number
  promise: Promise<void>
}>()
const pendingProjectMetadataRequests = new Map<string, {
  client: NonNullable<Instance["client"]>
  generation: number
  promise: Promise<void>
}>()

function hasMetadataLoaded(metadata?: Instance["metadata"]): boolean {
  if (!metadata) return false
  return "project" in metadata && "mcpStatus" in metadata && "plugins" in metadata
}

export function loadInstanceMetadata(instance: Instance, options?: { force?: boolean }): Promise<void> {
  const client = instance.client
  if (!client) {
    log.warn("[metadata] Skipping fetch; client missing", { instanceId: instance.id })
    return Promise.resolve()
  }

  const currentMetadata = getInstanceMetadata(instance.id) ?? instance.metadata
  if (!options?.force && hasMetadataLoaded(currentMetadata)) {
    return Promise.resolve()
  }

  const generation = getInstanceMetadataGeneration(instance.id)
  const pending = pendingMetadataRequests.get(instance.id)
  if (pending?.client === client && pending.generation === generation) return pending.promise
  const request = { client, generation, promise: Promise.resolve() as Promise<void> }
  request.promise = (async () => {
    try {
      const location = { directory: instance.folder }
      const [projectResult, projectsResult, mcpResult, pluginResult] = await Promise.allSettled([
        loadInstanceProjectMetadata(instance, options),
        client.project.list(),
        client.mcp.list({ location }),
        client.plugin.list({ location }),
      ])

      const currentProject = getInstanceMetadata(instance.id)?.project
      const listedProject = currentProject && projectsResult.status === "fulfilled"
        ? projectsResult.value.find((project) => project.id === currentProject.id)
        : undefined
      const plugins = pluginResult.status === "fulfilled"
        ? pluginResult.value.data.flatMap((plugin) => typeof plugin.id === "string" && !plugin.id.startsWith("opencode.") ? [plugin.id] : [])
        : undefined

      const updates: Instance["metadata"] = { ...(getInstanceMetadata(instance.id) ?? currentMetadata ?? {}) }

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


