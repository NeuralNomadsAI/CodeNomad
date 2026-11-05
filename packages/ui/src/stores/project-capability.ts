import { instances, isPendingCapabilityMetadataCurrent } from "./instances"
import { projectAvailability, type ProjectFeature } from "../lib/project-capability"
import { createMemo } from "solid-js"
import { getOpenCodeInstanceGeneration } from "./opencode-data"

export function getProjectAvailability(instanceId: string, feature: ProjectFeature) {
  return projectAvailability(instances().get(instanceId), feature, isPendingCapabilityMetadataCurrent(instanceId))
}

export function requireProjectAvailability(instanceId: string, feature: ProjectFeature): void {
  const availability = getProjectAvailability(instanceId, feature)
  if (!availability.allowed) throw Object.assign(new Error("explicit_capability_unavailable"), { code: "explicit_capability_unavailable" })
}

/** A stable view lifetime: ordinary metadata refreshes retain the local reader. */
export function createProjectAdmission(instanceId: () => string, feature: () => ProjectFeature) {
  return createMemo((previous: { instanceId: string; client: unknown; server: unknown; directory: unknown; folder: unknown; generation: unknown; nativeGeneration: number } | false | undefined) => {
    const id = instanceId()
    if (!getProjectAvailability(id, feature()).allowed) return false
    const source = instances().get(id)!
    const next = { instanceId: id, client: source.client, server: source.binding?.serverId, directory: source.binding?.directory, folder: source.folder, generation: source.capabilities?.generation, nativeGeneration: getOpenCodeInstanceGeneration(id) }
    return previous && Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next
  })
}
