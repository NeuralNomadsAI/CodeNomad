import type { Instance } from "../../types/instance"
import { getLogger } from "../../lib/logger"
import { getInstanceMetadata, mergeInstanceMetadata } from "../../stores/instance-metadata"
import { extractConfiguredPlugins } from "./plugin-metadata"

const log = getLogger("session")
const pendingMetadataRequests = new Set<string>()

function hasMetadataLoaded(metadata?: Instance["metadata"]): boolean {
  if (!metadata) return false
  return "project" in metadata && "mcpStatus" in metadata && "lspStatus" in metadata && "plugins" in metadata
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
    const [projectResult, mcpResult, configResult] = await Promise.allSettled([
      client.project.current({ location }),
      client.mcp.list({ location }),
      client.config.get({ location }),
    ])

    const project = projectResult.status === "fulfilled" ? projectResult.value : undefined
    const config = configResult.status === "fulfilled" ? configResult.value : undefined
    const plugins = config
      ? extractConfiguredPlugins(config.flatMap((entry) =>
          entry.type === "document"
            ? (entry.info.plugins ?? []).map((plugin) => typeof plugin === "string" ? plugin : plugin.package)
            : [],
        ))
      : undefined

    const updates: Instance["metadata"] = { ...(currentMetadata ?? {}) }

    if (projectResult.status === "fulfilled") {
      updates.project = project ?? null
    }

    if (mcpResult.status === "fulfilled") {
      updates.mcpStatus = mcpResult.value
    }

    updates.lspStatus = []

    if (configResult.status === "fulfilled") {
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


