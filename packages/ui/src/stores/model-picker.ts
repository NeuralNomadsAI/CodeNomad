import { createSignal } from "solid-js"
import { catalogModelKey, listCatalogModels, type CatalogModel } from "../lib/model-catalog"
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

// Display names from this window's Missions catalog reads, per instance. The separate
// Preferences window has no conversation catalog; this is display text only, never a
// selection or availability authority.
const [missionCatalogNames, setMissionCatalogNames] = createSignal(new Map<string, ReadonlyMap<string, string>>())

export function rememberModelNames(instanceId: string, models: readonly CatalogModel[]) {
  const names = new Map(models.filter((model) => model.name).map((model) => [catalogModelKey(model.providerId, model.id), model.name]))
  setMissionCatalogNames((previous) => new Map(previous).set(instanceId, names))
}

/** A model's display name from the instance's catalogs read in this window, without reading one. */
export function knownModelName(instanceId: string, model: { providerID: string; id: string }): string | undefined {
  const name = missionCatalogNames().get(instanceId)?.get(catalogModelKey(model.providerID, model.id))
  if (name) return name
  const provider = providers().get(instanceId)?.find((item) => item.id === model.providerID)
  return provider?.models.find((item) => item.id === model.id)?.name || undefined
}
