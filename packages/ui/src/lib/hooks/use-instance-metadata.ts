import type { Instance } from "../../types/instance"
import { getLogger } from "../../lib/logger"
import { getInstanceMetadata, mergeInstanceMetadata } from "../../stores/instance-metadata"

const log = getLogger("session")
const pendingMetadataRequests = new Set<string>()

function hasMetadataLoaded(metadata?: Instance["metadata"]): boolean {
  if (!metadata) return false
  return "project" in metadata && "mcpStatus" in metadata && "plugins" in metadata
}

export async function loadInstanceMetadata(instance: Instance, options?: { force?: boolean }): Promise<void> {
  const client = instance.client
  if (!client) {
    log.warn("[metadata] Skipping fetch; client missing", { instanceId: instance.id })
    return
  }

  const currentMetadata = getInstanceMetadata(instance.id) ?? instance.metadata
  if (!options?.force && hasMetadataLoaded(currentMetadata)) {
    return
  }

  if (pendingMetadataRequests.has(instance.id)) {
    return
  }

  pendingMetadataRequests.add(instance.id)

  try {
    const location = { directory: instance.folder }
    const [projectResult, projectsResult, mcpResult, pluginResult] = await Promise.allSettled([
      client.project.current({ location }),
      client.project.list(),
      client.mcp.list({ location }),
      client.plugin.list({ location }),
    ])

    const currentProject = projectResult.status === "fulfilled" ? projectResult.value : undefined
    const listedProject = currentProject && projectsResult.status === "fulfilled"
      ? projectsResult.value.find((project) => project.id === currentProject.id)
      : undefined
    const project = currentProject
      ? { ...currentProject, ...(listedProject?.vcs ? { vcs: listedProject.vcs } : {}) }
      : undefined
    const plugins = pluginResult.status === "fulfilled"
      ? pluginResult.value.data.map((plugin) => plugin.id).filter((id) => !id.startsWith("opencode."))
      : undefined

    const updates: Instance["metadata"] = { ...(currentMetadata ?? {}) }

    if (projectResult.status === "fulfilled") {
      updates.project = project ?? null
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


    mergeInstanceMetadata(instance.id, updates)
  } catch (error) {
    log.error("Failed to load instance metadata", error)
  } finally {
    pendingMetadataRequests.delete(instance.id)
  }
}

export { hasMetadataLoaded }


