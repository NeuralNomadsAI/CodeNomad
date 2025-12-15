import type { Instance, RawMcpStatus } from "../../types/instance"
import { fetchLspStatus, updateInstance } from "../../stores/instances"
import { getLogger } from "../../lib/logger"

const log = getLogger("session")
const pendingMetadataRequests = new Set<string>()

function hasMetadataLoaded(metadata?: Instance["metadata"]): boolean {
  if (!metadata) return false
  return "project" in metadata && "mcpStatus" in metadata && "lspStatus" in metadata
}

export async function loadInstanceMetadata(instance: Instance, options?: { force?: boolean }): Promise<void> {
  const client = instance.client
  if (!client) {
    log.warn("[metadata] Skipping fetch; client missing", { instanceId: instance.id })
    return
  }

  if (!options?.force && hasMetadataLoaded(instance.metadata)) {
    return
  }

  if (pendingMetadataRequests.has(instance.id)) {
    return
  }

  pendingMetadataRequests.add(instance.id)

  try {
    const [projectResult, mcpResult, lspResult] = await Promise.allSettled([
      client.project.current(),
      client.mcp.status(),
      fetchLspStatus(instance.id),
    ])

    const project = projectResult.status === "fulfilled" ? projectResult.value.data : undefined
    const mcpStatus = mcpResult.status === "fulfilled" ? (mcpResult.value.data as RawMcpStatus) : undefined
    const lspStatus = lspResult.status === "fulfilled" ? lspResult.value ?? [] : undefined

    const nextMetadata: Instance["metadata"] = {
      ...(instance.metadata ?? {}),
    }

    if (projectResult.status === "fulfilled") {
      nextMetadata.project = project ?? undefined
    }

    if (mcpResult.status === "fulfilled") {
      nextMetadata.mcpStatus = mcpStatus ?? nextMetadata.mcpStatus ?? {}
    }

    if (lspResult.status === "fulfilled") {
      nextMetadata.lspStatus = lspStatus ?? []
    }

    if (!nextMetadata?.version && instance.binaryVersion) {
      nextMetadata.version = instance.binaryVersion
    }

    updateInstance(instance.id, { metadata: nextMetadata })
  } catch (error) {
    log.error("Failed to load instance metadata", error)
  } finally {
    pendingMetadataRequests.delete(instance.id)
  }
}

export { hasMetadataLoaded }

