import type { Instance, RawMcpStatus } from "../../types/instance"
import { fetchLspStatus } from "../../stores/instances"
import { getLogger } from "../../lib/logger"
import { getInstanceMetadata, mergeInstanceMetadata } from "../../stores/instance-metadata"

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
    const [projectResult, mcpResult, lspResult, configResult] = await Promise.allSettled([
      client.project.current(),
      client.mcp.status(),
      fetchLspStatus(instance.id),
      client.config.get(),
    ])

    const project = projectResult.status === "fulfilled" ? projectResult.value.data : undefined
    const mcpStatus = mcpResult.status === "fulfilled" ? (mcpResult.value.data as RawMcpStatus) : undefined
    const lspStatus = lspResult.status === "fulfilled" ? lspResult.value ?? [] : undefined
    const config = configResult.status === "fulfilled" ? (configResult.value.data as { plugin?: unknown } | undefined) : undefined
    const plugins = Array.isArray(config?.plugin)
      ? (config?.plugin as string[]).map((plugin) =>
          plugin.startsWith("file://") ? plugin.slice("file://".length) : plugin,
        )
      : undefined

    const updates: Instance["metadata"] = { ...(currentMetadata ?? {}) }

    if (projectResult.status === "fulfilled") {
      updates.project = project ?? null
    }

    if (mcpResult.status === "fulfilled") {
      updates.mcpStatus = mcpStatus ?? {}
    }

    if (lspResult.status === "fulfilled") {
      updates.lspStatus = lspStatus ?? []
    }

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


