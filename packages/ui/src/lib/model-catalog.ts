import type { Model, Provider } from "../types/session"
import { isModelVisible, type ModelVisibilityPreference } from "./model-visibility"

/** The native provider and model reads a model catalog is built from. */
export interface NativeCatalogProvider { id: string; name: string }
export interface NativeCatalogModel {
  providerID: string
  id: string
  name: string
  status: string
  limit: Model["limit"]
  cost: readonly NonNullable<Model["cost"]>[]
  variants: readonly { id: string }[]
}

/** A catalog model with its provider's display name, as the model selectors list it. */
export interface CatalogModel extends Model { providerName: string }

export interface ModelListPreferences {
  visibility(providerId: string): ModelVisibilityPreference | undefined
  favorites: readonly { providerId?: string; modelId?: string }[]
  favoritesOnly: boolean
}

export interface ModelList<T> {
  /** Models the provider visibility preference shows, by provider, name and ID. */
  visible: T[]
  /** The visible favorites. */
  favorites: T[]
  /** The favorites-only mode applies: it is chosen and a favorite remains. */
  favoritesOnly: boolean
  /** What the selector lists. */
  shown: T[]
}

export const catalogModelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`

const compareIds = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" })

export function compareCatalogModels(left: Model, right: Model): number {
  return compareIds(left.providerId, right.providerId) || compareIds(left.name, right.name) || compareIds(left.id, right.id)
}

/** Every listed provider with its non-deprecated models, ordered by ID, under their display names. */
export function buildProviderCatalog(
  providers: readonly NativeCatalogProvider[],
  models: readonly NativeCatalogModel[],
  defaultModel?: NativeCatalogModel | null,
): Provider[] {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const modelsById = new Map(models.map((model) => [`${model.providerID}:${model.id}`, model]))
  if (defaultModel) modelsById.set(`${defaultModel.providerID}:${defaultModel.id}`, defaultModel)
  const providerIds = new Set([...providersById.keys(), ...Array.from(modelsById.values(), (model) => model.providerID)])
  return Array.from(providerIds).sort().map((providerId) => ({
    id: providerId,
    name: providersById.get(providerId)?.name ?? providerId,
    defaultModelId: defaultModel?.providerID === providerId ? defaultModel.id : undefined,
    models: Array.from(modelsById.values()).filter((model) => model.providerID === providerId && model.status !== "deprecated").sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({
      id: model.id,
      name: model.name,
      providerId,
      limit: model.limit,
      cost: model.cost[0],
      variantKeys: model.variants.map((variant) => variant.id),
    })),
  }))
}

export function catalogModels(providers: readonly Provider[]): CatalogModel[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({ ...model, providerName: provider.name })))
}

export function favoriteModelKeys(favorites: ModelListPreferences["favorites"]): Set<string> {
  const keys = new Set<string>()
  for (const item of favorites) if (item.providerId && item.modelId) keys.add(catalogModelKey(item.providerId, item.modelId))
  return keys
}

/** The conversation model selector's list: models the provider visibility preference hides
 *  are left out, and the favorites-only mode keeps only favorites while one remains. */
export function listCatalogModels<T extends Model>(models: readonly T[], preferences: ModelListPreferences): ModelList<T> {
  const visible = models.filter((model) => isModelVisible(preferences.visibility(model.providerId), model.id)).sort(compareCatalogModels)
  const keys = favoriteModelKeys(preferences.favorites)
  const favorites = keys.size ? visible.filter((model) => keys.has(catalogModelKey(model.providerId, model.id))) : []
  const favoritesOnly = favorites.length > 0 && preferences.favoritesOnly
  return { visible, favorites, favoritesOnly, shown: favoritesOnly ? favorites : visible }
}
