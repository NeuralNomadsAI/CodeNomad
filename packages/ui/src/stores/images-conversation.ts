import type { ImagesConversationResponse } from "../../../server/src/server/routes/images-conversation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import type { Session } from "../types/session"
import { requestComposerFocus } from "./composer-focus"
import { fetchAgents, getActiveCatalogLocation, hydrateRestoredSessionChain } from "./session-api"
import { getDefaultModel } from "./session-models"
import { agents, prependSessionListId, setActiveParentSession } from "./session-state"

export const DESIGN_AGENT_ID = "design"
const COMPANION_KEY = "codenomad.companion"

/** A root session marked `codenomad.companion: images` at creation; marked children inherit nothing. */
export function isImagesConversation(session: Pick<Session, "parentId" | "metadata"> | undefined): boolean {
  return Boolean(session && !session.parentId && (session.metadata as Record<string, unknown> | undefined)?.[COMPANION_KEY] === "images")
}

/** Whether the loaded agent catalog of the active location lacks `design`; unknown while it has not loaded. */
export function isDesignAgentMissing(instanceId: string): boolean {
  const catalog = agents().get(instanceId)
  return Boolean(catalog) && !catalog!.some(agent => agent.id === DESIGN_AGENT_ID)
}

/**
 * Finds or creates the Images conversation of the current location (the
 * displayed conversation's, else the instance folder): `open` creates only
 * when the authoritative lookup is `absent`, `new` always creates. A created
 * conversation gets the Design agent when the location has it, and the model
 * CodeNomad resolves for that agent; a found one keeps its own.
 */
export async function resolveImagesConversation(instanceId: string, mode: "open" | "new"): Promise<ImagesConversationResponse> {
  const location = getActiveCatalogLocation(instanceId)
  await fetchAgents(instanceId, location, true)
  const agent = isDesignAgentMissing(instanceId) || !agents().get(instanceId) ? undefined : DESIGN_AGENT_ID
  const model = await getDefaultModel(instanceId, agent)
  return serverApi.imagesConversation(instanceId, {
    directory: location.directory, mode, title: tGlobal("imagesConversation.title"),
    ...(agent ? { agent } : {}),
    ...(model.providerId && model.modelId ? { model: { providerID: model.providerId, id: model.modelId } } : {}),
  })
}

/** Shows a found conversation and focuses its composer; nothing is sent. */
export async function showImagesConversation(instanceId: string, result: Extract<ImagesConversationResponse, { status: "found" }>): Promise<void> {
  await hydrateRestoredSessionChain(instanceId, [result.sessionID])
  if (result.created) prependSessionListId(instanceId, result.sessionID)
  setActiveParentSession(instanceId, result.sessionID)
  requestComposerFocus(instanceId, result.sessionID)
}

/** `resolveImagesConversation`, then `showImagesConversation` when found. */
export async function openImagesConversation(instanceId: string, mode: "open" | "new"): Promise<ImagesConversationResponse> {
  const result = await resolveImagesConversation(instanceId, mode)
  if (result.status === "found") await showImagesConversation(instanceId, result)
  return result
}
