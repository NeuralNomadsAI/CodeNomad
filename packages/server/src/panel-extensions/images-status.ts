import type { LocationRef, OpenCodeClient } from "@opencode/client"
import type { ImageSettings } from "../opencode/image-settings"
import { designAgentStatus } from "../opencode/design/status"
import { locationRequestOptions } from "../opencode/compatibility/location"
import type { PanelImagesStatus } from "./contract"

type ModelRef = { providerID: string; id: string }
const refOf = (value: unknown): ModelRef | undefined => {
  const ref = value as { providerID?: unknown; id?: unknown } | undefined
  return typeof ref?.providerID === "string" && typeof ref.id === "string" ? { providerID: ref.providerID, id: ref.id } : undefined
}
const same = (model: unknown, ref: ModelRef) => (model as ModelRef).providerID === ref.providerID && (model as ModelRef).id === ref.id

/**
 * API 4 `images.status()` at one owned Location: image generation (`experimental.image_generate`
 * in the daemon schema and its effective value), image models, the Design agent's provenance
 * (dev-docs/OPENCODE_COMPATIBILITY.md) and, for a conversation, whether its effective chat model
 * takes images: the session's, else its agent's when available, else the native default. No
 * provider names or keys leave this function.
 */
export async function readPanelImagesStatus(deps: { imageSettings: Pick<ImageSettings, "read">; client: OpenCodeClient },
  workspaceId: string, location: LocationRef, session?: { agent?: unknown; model?: unknown }, signal?: AbortSignal): Promise<PanelImagesStatus> {
  const request = { location: { directory: location.directory } }, options = { ...locationRequestOptions(location), ...(signal ? { signal } : {}) }
  const [settings, agents, models, fallback] = await Promise.all([
    deps.imageSettings.read(workspaceId, { directory: location.directory }),
    deps.client.agent.list(request, options),
    session ? deps.client.model.list(request, options) : undefined,
    session ? deps.client.model.default(request, options).catch(() => undefined) : undefined,
  ])
  const generation = settings.generation
  const design = designAgentStatus(agents.data)
  let chatModelSeesImages: boolean | null = null
  if (session && models) {
    const agentModel = refOf(agents.data.find(agent => agent.id === session.agent)?.model)
    const ref = refOf(session.model) ?? (agentModel && models.data.some(model => same(model, agentModel)) ? agentModel : undefined)
      ?? refOf(fallback?.data)
    const model = ref && [...models.data, ...(fallback?.data ? [fallback.data] : [])].find(model => same(model, ref))
    chatModelSeesImages = model ? model.capabilities.input.some(input => input.startsWith("image")) : null
  }
  return {
    generation: !generation ? "unsupported" : generation.effective === false ? "disabled" : "available",
    imageModels: (generation?.models?.length ?? 0) > 0,
    ...design,
    chatModelSeesImages,
  }
}
