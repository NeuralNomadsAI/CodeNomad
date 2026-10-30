import { createSignal } from "solid-js"
import { catalogModelKey, listCatalogModels, type CatalogModel } from "../lib/model-catalog"
import type { Provider } from "../types/session"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { getFavoritesOnlyPreference, getProviderModelVisibilityPreference, uiState } from "./preferences"
import { providers } from "./session-state"

/** The list the conversation's model selector shows, under the user's model preferences. */
export function preferredModelList<T extends CatalogModel>(models: readonly T[]) {
  return listCatalogModels(models, {
    visibility: getProviderModelVisibilityPreference,
    favorites: uiState().models.favorites ?? [],
    favoritesOnly: getFavoritesOnlyPreference(),
  })
}

interface RememberedNames {
  names: ReadonlyMap<string, string>
  directory: string
  generation: number
  /** The conversation catalog current when the Missions catalog was read. */
  conversation: readonly Provider[] | undefined
}

// Display names from this window's latest Missions catalog read, per instance. The separate
// Preferences window has no conversation catalog; this is display text only, never a
// selection or availability authority.
const [missionCatalogNames, setMissionCatalogNames] = createSignal(new Map<string, RememberedNames>())

export function rememberModelNames(instanceId: string, directory: string | undefined, models: readonly CatalogModel[]) {
  const names = new Map(models.filter((model) => model.name).map((model) => [catalogModelKey(model.providerId, model.id), model.name]))
  const remembered = { names, directory: directory ?? "", generation: getOpenCodeInstanceGeneration(instanceId), conversation: providers().get(instanceId) }
  setMissionCatalogNames((previous) => new Map(previous).set(instanceId, remembered))
}

/** A model's display name from the instance's catalogs read in this window, without reading one:
 *  the newer of the conversation catalog and the Location's latest Missions catalog read. */
export function knownModelName(instanceId: string, directory: string | undefined, model: { providerID: string; id: string }): string | undefined {
  const conversation = providers().get(instanceId)
  const fromConversation = conversation?.find((item) => item.id === model.providerID)?.models.find((item) => item.id === model.id)?.name || undefined
  const remembered = missionCatalogNames().get(instanceId)
  // Names read before a reconnect or for another Location do not apply.
  if (!remembered || remembered.directory !== (directory ?? "") || remembered.generation !== getOpenCodeInstanceGeneration(instanceId)) return fromConversation
  const fromMissions = remembered.names.get(catalogModelKey(model.providerID, model.id))
  // A conversation catalog published after that read is the fresher one.
  return remembered.conversation === conversation ? fromMissions ?? fromConversation : fromConversation ?? fromMissions
}
