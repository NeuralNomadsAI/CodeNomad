import type { ImagesConversationResponse } from "../../../server/src/server/routes/images-conversation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import type { LocationRef } from "@opencode/client"
import type { Agent, Session } from "../types/session"
import { requestComposerFocus } from "./composer-focus"
import { locationAuthorityKey } from "./request-locations"
import { fetchAgents, getActiveCatalogLocation, hydrateRestoredSessionChain } from "./session-api"
import { getDefaultModel } from "./session-models"
import { agentCatalogLocations, agents, prependSessionListId, setActiveParentSession } from "./session-state"

export const DESIGN_AGENT_ID = "design"
const COMPANION_KEY = "codenomad.companion"

/** A root session marked `codenomad.companion: images` at creation; marked children inherit nothing. */
export function isImagesConversation(session: Pick<Session, "parentId" | "metadata"> | undefined): boolean {
  return Boolean(session && !session.parentId && (session.metadata as Record<string, unknown> | undefined)?.[COMPANION_KEY] === "images")
}

/** The instance's agent list when it was read for `location`; another Location's list counts as not loaded. */
export function locationAgents(instanceId: string, location: LocationRef): Agent[] | undefined {
  return agentCatalogLocations().get(instanceId) === locationAuthorityKey(location) ? agents().get(instanceId) : undefined
}

/** Whether `location`'s loaded agent catalog lacks `design`; false while that catalog is not loaded. */
export function isDesignAgentMissing(instanceId: string, location: LocationRef): boolean {
  const catalog = locationAgents(instanceId, location)
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
  // Without a fresh catalog of this Location, Design's presence is unknown: create nothing.
  if (!await fetchAgents(instanceId, location, true)) return { status: "unknown" }
  const catalog = locationAgents(instanceId, location)
  if (!catalog) return { status: "unknown" }
  const agent = catalog.some(entry => entry.id === DESIGN_AGENT_ID) ? DESIGN_AGENT_ID : undefined
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
