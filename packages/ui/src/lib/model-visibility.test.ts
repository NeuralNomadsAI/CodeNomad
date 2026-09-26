import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  isModelVisible,
  normalizeModelVisibilityPreference,
  normalizeModelVisibilityPreferences,
  resolvePickerValue,
} from "./model-visibility"

test("normalizes malformed preferences fail-open", () => {
  assert.deepEqual(normalizeModelVisibilityPreference(null), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreference({ mode: "custom", modelIds: ["legacy"] }), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreference({ hiddenModelIds: "hidden" }), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreferences([]), {})
  assert.deepEqual(normalizeModelVisibilityPreferences({ broken: { hiddenModelIds: null } }), {
    broken: { hiddenModelIds: [] },
  })
})

test("keeps unique non-empty exact IDs without catalog-based deletion", () => {
  assert.deepEqual(
    normalizeModelVisibilityPreference({ hiddenModelIds: ["Model-A", "model-a", "", "Model-A", 7] }),
    { hiddenModelIds: ["Model-A", "model-a"] },
  )
})

test("matches hidden IDs exactly and case-sensitively", () => {
  const preference = { hiddenModelIds: ["Model-A"] }
  assert.equal(isModelVisible(preference, "Model-A"), false)
  assert.equal(isModelVisible(preference, "model-a"), true)
})

test("new models and missing preferences are visible by default", () => {
  assert.equal(isModelVisible({ hiddenModelIds: ["known"] }, "new"), true)
  assert.equal(isModelVisible(undefined, "new"), true)
})

test("a current model receives no helper-level visibility override", () => {
  assert.equal(isModelVisible({ hiddenModelIds: ["current"] }, "current"), false)
})

test("uses the current model as the picker value only while it remains in the collection", () => {
  const current = { key: "provider/current" }
  assert.equal(resolvePickerValue(current, [current]), current)
  assert.equal(resolvePickerValue(current, [{ key: "provider/visible" }]), undefined)
})

test("provider refresh updates shared and modal catalogs without disposing active instances", () => {
  const source = fs.readFileSync(
    new URL("../components/provider-auth/provider-manager-modal.tsx", import.meta.url),
    "utf8",
  )
  const start = source.indexOf("async function refreshProviderData()")
  const end = source.indexOf("function closeModelManager()", start)
  const refresh = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(refresh, /const catalogLocation = currentCatalogLocation\(\)/)
  assert.match(refresh, /if \(!props\.location\) await fetchProviders\(instanceId, catalogLocation, true\)/)
  assert.match(refresh, /await loadProviderData\(authClient, \+\+loadVersion, catalogLocation\)/)
  assert.doesNotMatch(refresh, /global\.dispose/)
})

test("model picker delegates keyboard selection to its accessible Kobalte input", () => {
  const source = fs.readFileSync(new URL("../components/model-selector.tsx", import.meta.url), "utf8")
  const kobalteInput = fs.readFileSync(
    new URL("../../../../node_modules/@kobalte/core/src/combobox/combobox-input.tsx", import.meta.url),
    "utf8",
  )
  const kobalteBase = fs.readFileSync(
    new URL("../../../../node_modules/@kobalte/core/src/combobox/combobox-base.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /const \[openComboboxValue, setOpenComboboxValue\] = createSignal<FlatModel \| undefined>\(\)/)
  assert.match(source, /value=\{isOpen\(\) \? openComboboxValue\(\) : comboboxValue\(\)\}/)
  assert.match(source, /if \(next\) setOpenComboboxValue\(comboboxValue\(\)\)\s*setIsOpen\(next\)/)
  assert.match(source, /optionTextValue="searchText"/)
  assert.match(source, /optionLabel=\{\(option\) => isProviderHeaderOption\(option\)[\s\S]{0,160}modelSelector\.trigger\.primary/)
  assert.match(source, /onInputChange=\{setInputValue\}/)
  assert.match(source, /const context = useComboboxContext\(\)[\s\S]{0,100}context\.setInputValue\(props\.value\)/)
  assert.match(source, /else if \(triggerMode !== "input"\) setInputValue\(""\)/)
  assert.equal(source.match(/<Combobox\.Input/g)?.length, 2)
  assert.match(source, /<Combobox\.Input class="sr-only" data-model-selector/)
  const search = source.slice(source.indexOf('<div class="selector-search-container">'), source.indexOf("<Combobox.Listbox"))
  assert.match(search, /<Combobox\.Input[\s\S]{0,300}value=\{inputValue\(\)\}/)
  assert.match(search, /class="selector-input-group"[\s\S]*class="selector-favorites-toggle"/)
  assert.match(search, /title=\{favoritesToggleLabel\(\)\}/)
  assert.match(search, /aria-pressed=\{favoritesOnlyPreference\(\)\}[\s\S]*disabled=\{!canChooseFavoritesMode\(\) \|\| searchActive\(\)\}[\s\S]*data-active=\{favoritesOnlyPreference\(\)\}/)
  assert.doesNotMatch(search, /<input\b/)
  assert.match(source, /onKeyDown=\{\(event\) => \{\s*if \(event\.key === "Escape"\) queueMicrotask\(restoreSelectedInput\)/)
  assert.doesNotMatch(source, /dispatchEvent\(new KeyboardEvent/)
  assert.doesNotMatch(source, /const first = pickerOptions\(\)\.find/)
  assert.equal(source.match(/aria-label=\{currentModelAccessibleLabel\(\)\}/g)?.length, 2)
  assert.match(source, /id: `\$\{current\.providerId\}\/\$\{current\.id\}`/)
  const grouping = source.slice(source.indexOf("const groupedVisibleOptions"), source.indexOf("const pickerOptions"))
  const openEffectStart = source.indexOf("createEffect(() => {", source.indexOf("const customFilter"))
  const openEffect = source.slice(openEffectStart, source.indexOf("const preventListboxPress", openEffectStart))
  const kobalteOnInput = kobalteInput.slice(kobalteInput.indexOf("const onInput:"), kobalteInput.indexOf("const onKeyDown:"))
  assert.doesNotMatch(grouping, /inputValue|query/)
  assert.doesNotMatch(openEffect.slice(openEffect.indexOf("if (isOpen())"), openEffect.indexOf("} else")), /setInputValue/)
  assert.ok(kobalteOnInput.indexOf("callHandler(e, local.onInput)") < kobalteOnInput.indexOf("context.setInputValue(target.value)"))
  assert.ok(kobalteOnInput.indexOf("context.setInputValue(target.value)") < kobalteOnInput.indexOf('context.open(false, "input")'))
  assert.match(kobalteBase, /onInputChange\?: \(value: string\) => void/)
  assert.doesNotMatch(kobalteBase.slice(kobalteBase.indexOf("export interface ComboboxBaseOptions"), kobalteBase.indexOf("export interface ComboboxBaseRenderProps")), /inputValue\?:/)
  assert.match(source, /const closePicker = \(\) => \{\s*setIsOpen\(false\)\s*restoreSelectedInput\(\)/)
  assert.match(source, /if \(!next\) restoreSelectedInput\(\)/)
  assert.match(source, /closePicker\(\)\s*setProvidersModalOpen\(true\)/)
  const footer = source.slice(source.indexOf('<div class="selector-footer">'), source.indexOf("</Combobox.Content>"))
  assert.doesNotMatch(footer, /toggleFavoritesOnly/)
  assert.doesNotMatch(footer, /favoritesOnly\.showAll/)
})

test("the favorites mode is a stored preference that never follows the active model", () => {
  const source = fs.readFileSync(new URL("../components/model-selector.tsx", import.meta.url), "utf8")
  const mode = source.slice(source.indexOf("const favoritesOnlyPreference"), source.indexOf("const visibleOptions"))
  const visible = source.slice(source.indexOf("const visibleOptions"), source.indexOf("const groupedVisibleOptions"))
  const toggle = source.slice(source.indexOf("const canChooseFavoritesMode"), source.indexOf("const favoritesToggleLabel"))

  // The stored choice is reported as such and is revocable even without favorites.
  assert.match(mode, /const favoritesOnlyPreference = \(\) => getFavoritesOnlyPreference\(\)/)
  assert.match(mode, /createMemo\(\(\) => hasFavorites\(\) && favoritesOnlyPreference\(\)\)/)
  assert.doesNotMatch(mode, /searchActive|currentModelIsFavorite/)
  assert.match(toggle, /const canChooseFavoritesMode = createMemo\(\(\) => hasFavorites\(\) \|\| favoritesOnlyPreference\(\)\)/)
  assert.match(toggle, /setFavoritesOnlyPreference\(!favoritesOnlyPreference\(\)\)/)
  assert.doesNotMatch(toggle, /if \(!hasFavorites\(\)\) return/)

  // The active model is added to the chosen mode unless its own visibility
  // preference hides it, which keeps a hidden model unselectable.
  assert.match(visible, /const modeModels = favoritesOnlyEnabled\(\) \? favoriteModels\(\) : sortedModels\(\)/)
  assert.match(visible, /if \(!current \|\| modeModels\.some\(\(model\) => model\.key === current\.key\)\) return modeModels/)
  assert.match(visible, /const hiddenByPreference = !current\.unavailable && !isModelVisible\([\s\S]{0,140}current\.id,[\s\S]{0,40}\)/)
  assert.match(visible, /if \(hiddenByPreference\) return modeModels/)
  assert.match(visible, /return \[\.\.\.modeModels, current\]\.sort\(compareModels\)/)

  for (const removed of [
    "setManualAll", "setExplicitFavorites", "autoFavoritesEligibleAtOpen",
    "wasFavoritesOnlyEnabled", "wasCurrentModelFavorite", "currentModelIsFavorite",
  ]) {
    assert.doesNotMatch(source, new RegExp(removed))
  }

  // The write is published synchronously and serialized in click order.
  const preferences = fs.readFileSync(new URL("../stores/preferences.tsx", import.meta.url), "utf8")
  assert.match(preferences, /favoritesOnly: \(source\.models as any\)\?\.favoritesOnly === true/)
  assert.match(preferences, /models: \{\s*recents: ModelPreference\[\]\s*favorites: ModelPreference\[\]\s*thinkingSelections: Record<string, string>\s*favoritesOnly: boolean\s*\}/)
  const modeStore = preferences.slice(preferences.indexOf("const [pendingFavoritesOnly"), preferences.indexOf("function getModelThinkingSelection"))
  assert.match(modeStore, /return pendingFavoritesOnly\(\) \?\? uiState\(\)\.models\.favoritesOnly/)
  assert.match(modeStore, /if \(getFavoritesOnlyPreference\(\) === enabled\) return\s*setPendingFavoritesOnly\(enabled\)/)
  assert.match(modeStore, /const previous = favoritesOnlyWriteQueue\s*favoritesOnlyWriteQueue = previous\.catch\(\(\) => undefined\)\.then\(async \(\) => \{[\s\S]{0,240}settlePending\(\)/)
})

test("provider auth keeps its catalog location across deferred operation steps", () => {
  const source = fs.readFileSync(
    new URL("../components/provider-auth/provider-manager-modal.tsx", import.meta.url),
    "utf8",
  )
  const oauth = source.slice(source.indexOf("async function submitOAuthAuthorize"), source.indexOf("async function submitCommandAuth"))
  const command = source.slice(source.indexOf("async function submitCommandAuth"), source.indexOf("async function submitAuth()"))
  const submit = source.slice(source.indexOf("async function submitAuth()"), source.indexOf("async function submitOAuthCode()"))
  const complete = source.slice(source.indexOf("async function submitOAuthCode()"), source.indexOf("async function disconnectProvider"))
  const cancel = source.slice(source.indexOf("function cancelOAuthWait()"), source.indexOf("function methodSummary"))

  const loadEffect = source.slice(source.indexOf("createEffect(() => {"), source.indexOf("createEffect(() => {", source.indexOf("createEffect(() => {") + 1))
  assert.match(loadEffect, /const catalogLocation = currentCatalogLocation\(\)/)
  assert.match(loadEffect, /loadedCatalogLocationKey === catalogLocationKey\) return/)
  assert.match(loadEffect, /loadProviderData\(authClient, version, catalogLocation\)/)
  assert.match(source, /const isCurrentLoad = \(\) => version === loadVersion[\s\S]{0,160}isActiveCatalogLocation\(catalogLocation\)/)
  assert.equal(oauth.match(/location: requestLocation\(catalogLocation\)/g)?.length, 2)
  assert.equal(command.match(/location: requestLocation\(catalogLocation\)/g)?.length, 2)
  assert.match(submit, /const catalogLocation = currentCatalogLocation\(\)/)
  assert.match(submit, /authCatalogLocation = catalogLocation/)
  assert.match(complete, /const catalogLocation = authCatalogLocation/)
  assert.match(complete, /location: requestLocation\(catalogLocation\)/)
  assert.match(complete, /refreshAfterAuth\(authClient, instanceId, operationVersion, catalogLocation\)/)
  assert.match(cancel, /const catalogLocation = authCatalogLocation/)
  assert.equal(cancel.match(/location: requestLocation\(catalogLocation\)/g)?.length, 2)
})

test("serializes visibility writes across providers before installing server snapshots", () => {
  const source = fs.readFileSync(new URL("../stores/preferences.tsx", import.meta.url), "utf8")
  assert.match(source, /let modelVisibilityWriteQueue = Promise\.resolve\(\)/)
  assert.match(source, /const previous = modelVisibilityWriteQueue/)
  assert.match(source, /modelVisibilityWriteQueue = write/)
})
