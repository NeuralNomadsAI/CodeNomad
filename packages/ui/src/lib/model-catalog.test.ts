import assert from "node:assert/strict"
import test from "node:test"
import { buildProviderCatalog, catalogModels, listCatalogModels, type ModelListPreferences } from "./model-catalog"

const native = (providerID: string, id: string, name: string, status = "active") => ({
  providerID, id, name, status, limit: { context: 1, output: 1 }, cost: [{ input: 1, output: 2 }], variants: [{ id: "high" }],
})

const preferences = (overrides: Partial<ModelListPreferences> = {}): ModelListPreferences => ({
  visibility: () => undefined, favorites: [], favoritesOnly: false, ...overrides,
})

test("the catalog names providers and models, drops deprecated models and keeps the default model", () => {
  const catalog = buildProviderCatalog(
    [{ id: "claude-code", name: "Claude Code" }, { id: "empty", name: "Empty" }],
    [native("claude-code", "claude-opus-5-5[1m]", "Opus 5.5 Fast"), native("claude-code", "old", "Old", "deprecated"), native("zen", "free", "Free")],
    native("zen", "default", "Default"),
  )
  assert.deepEqual(catalog.map(provider => [provider.id, provider.name, provider.defaultModelId, provider.models.map(model => model.name)]), [
    ["claude-code", "Claude Code", undefined, ["Opus 5.5 Fast"]],
    ["empty", "Empty", undefined, []],
    ["zen", "zen", "default", ["Default", "Free"]],
  ])
  assert.deepEqual(catalog[0].models[0], {
    id: "claude-opus-5-5[1m]", name: "Opus 5.5 Fast", providerId: "claude-code", limit: { context: 1, output: 1 }, cost: { input: 1, output: 2 }, variantKeys: ["high"],
  })
  assert.deepEqual(catalogModels(catalog).map(model => [model.providerName, model.name]),
    [["Claude Code", "Opus 5.5 Fast"], ["zen", "Default"], ["zen", "Free"]])
})

test("the list leaves out hidden models and orders the rest by provider, name and ID", () => {
  const models = catalogModels(buildProviderCatalog([], [native("openai", "b", "Beta"), native("anthropic", "z", "Alpha"), native("openai", "a", "Beta"), native("openai", "h", "Hidden")]))
  const list = listCatalogModels(models, preferences({ visibility: providerId => providerId === "openai" ? { hiddenModelIds: ["h"] } : undefined }))
  assert.deepEqual(list.visible.map(model => `${model.providerId}/${model.id}`), ["anthropic/z", "openai/a", "openai/b"])
  assert.deepEqual(list.shown, list.visible)
  assert.equal(list.favoritesOnly, false)
})

test("favorites-only lists visible favorites while one remains, else every visible model", () => {
  const models = catalogModels(buildProviderCatalog([], [native("openai", "gpt", "GPT"), native("zen", "free", "Free"), native("zen", "gone", "Gone")]))
  const favorites = [{ providerId: "zen", modelId: "free" }, { providerId: "zen", modelId: "gone" }, { providerId: "", modelId: "gpt" }]
  const hideGone = { visibility: (providerId: string) => providerId === "zen" ? { hiddenModelIds: ["gone"] } : undefined }
  const only = listCatalogModels(models, preferences({ favorites, favoritesOnly: true, ...hideGone }))
  assert.equal(only.favoritesOnly, true)
  assert.deepEqual(only.shown.map(model => model.id), ["free"], "a hidden favorite stays hidden")
  const all = listCatalogModels(models, preferences({ favorites, favoritesOnly: false, ...hideGone }))
  assert.deepEqual(all.shown.map(model => model.id), ["gpt", "free"])
  assert.deepEqual(all.favorites.map(model => model.id), ["free"])
  const none = listCatalogModels(models, preferences({ favorites: [{ providerId: "zen", modelId: "gone" }], favoritesOnly: true, ...hideGone }))
  assert.equal(none.favoritesOnly, false, "without a visible favorite the mode has nothing to restrict to")
  assert.deepEqual(none.shown.map(model => model.id), ["gpt", "free"])
})
