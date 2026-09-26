import { Combobox, useComboboxContext } from "@kobalte/core/combobox"
import { createEffect, createMemo, createSignal } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { waitForInstanceInitialSessionHydration } from "../stores/instances"
import { ChevronDown, PlugZap, Star } from "lucide-solid"
import type { Model } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { getFavoritesOnlyPreference, getProviderModelVisibilityPreference, setFavoritesOnlyPreference, uiState, toggleFavoriteModelPreference } from "../stores/preferences"
import { ProviderManagerModal } from "./provider-auth/provider-manager-modal"
import { isModelVisible, resolvePickerValue } from "../lib/model-visibility"
const log = getLogger("session")

interface ModelSelectorProps {
  instanceId: string
  sessionId: string
  currentModel: { providerId: string; modelId: string }
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

interface FlatModel extends Model {
  providerName: string
  key: string
  searchText: string
  unavailable?: boolean
}

interface ModelGroup {
  providerId: string
  providerName: string
  models: FlatModel[]
}

interface ProviderHeaderOption {
  type: "header"
  key: string
  providerId: string
  providerName: string
  searchText: string
}

type PickerOption = FlatModel | ProviderHeaderOption

const compareIds = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" })

const compareModels = (left: FlatModel, right: FlatModel) => {
  const providerComparison = compareIds(left.providerId, right.providerId)
  if (providerComparison !== 0) return providerComparison
  const nameComparison = compareIds(left.name, right.name)
  if (nameComparison !== 0) return nameComparison
  return compareIds(left.id, right.id)
}

const isProviderHeaderOption = (option: PickerOption): option is ProviderHeaderOption => "type" in option && option.type === "header"

function ComboboxInputValue(props: { value: string }) {
  const context = useComboboxContext()
  createEffect(() => context.setInputValue(props.value))
  return null
}

export default function ModelSelector(props: ModelSelectorProps) {
  const { t } = useI18n()
  const instanceProviders = () => providers().get(props.instanceId) || []
  const [isOpen, setIsOpen] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [openComboboxValue, setOpenComboboxValue] = createSignal<FlatModel | undefined>()
  const [providersModalOpen, setProvidersModalOpen] = createSignal(false)
  let searchInputRef!: HTMLInputElement
  let suppressNextClose = false

  createEffect(() => {
    if (instanceProviders().length === 0) {
      const instanceId = props.instanceId
      void waitForInstanceInitialSessionHydration(instanceId)
        .then(() => fetchProviders(instanceId))
        .catch((error) => log.error("Failed to fetch providers", error))
    }
  })

  const catalogModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        providerName: p.name,
        key: `${m.providerId}/${m.id}`,
        searchText: `${m.name} ${p.name} ${m.providerId} ${m.id} ${m.providerId}/${m.id}`,
      })),
    ),
  )

  const allModels = createMemo(() => catalogModels().filter((model) =>
    isModelVisible(
      getProviderModelVisibilityPreference(model.providerId),
      model.id,
    ),
  ))

  const sortedModels = createMemo<FlatModel[]>(() => [...allModels()].sort(compareModels))

  const favoriteKeySet = createMemo(() => {
    const result = new Set<string>()
    for (const item of uiState().models.favorites ?? []) {
      if (item.providerId && item.modelId) {
        result.add(`${item.providerId}/${item.modelId}`)
      }
    }
    return result
  })

  const favoriteModels = createMemo<FlatModel[]>(() => {
    const keys = favoriteKeySet()
    if (keys.size === 0) return []
    return sortedModels().filter((m) => keys.has(m.key))
  })

  const hasFavorites = createMemo(() => favoriteModels().length > 0)

  const currentModelValue = createMemo<FlatModel | undefined>(() => {
    const current = props.currentModel
    const found = catalogModels().find((model) => model.providerId === current.providerId && model.id === current.modelId)
    if (found) return found
    if (!current.providerId || !current.modelId) return undefined
    const providerName = instanceProviders().find((provider) => provider.id === current.providerId)?.name ?? current.providerId
    return {
      id: current.modelId,
      name: t("modelSelector.unavailableModel", { model: current.modelId }),
      providerId: current.providerId,
      providerName,
      key: `${current.providerId}/${current.modelId}`,
      searchText: `${current.modelId} ${providerName} ${current.providerId}`,
      unavailable: true,
    }
  })

  const currentModelName = () => currentModelValue()?.name ?? t("modelSelector.none")

  const currentModelLabel = createMemo(() =>
    t("modelSelector.trigger.primary", { model: currentModelName() }),
  )

  const searchActive = createMemo(() => isOpen()
    && inputValue().trim().length > 0
    && inputValue() !== currentModelLabel())

  // The favorites/all choice is a stored preference, not a consequence of the
  // active model, so it survives reopening the picker, model changes and
  // searching. Searching only filters within the chosen mode.
  const favoritesOnlyPreference = () => getFavoritesOnlyPreference()

  // Without any favorite left there is nothing to restrict the list to, but the
  // stored choice is kept so it applies again as soon as one is added.
  const favoritesOnlyEnabled = createMemo(() => hasFavorites() && favoritesOnlyPreference())

  // The active model stays reachable whichever mode is chosen, so a non-favorite
  // selection never silently vanishes from its own picker. A model the provider
  // visibility preference hides stays hidden and unselectable.
  const visibleOptions = createMemo<FlatModel[]>(() => {
    const modeModels = favoritesOnlyEnabled() ? favoriteModels() : sortedModels()
    const current = currentModelValue()
    if (!current || modeModels.some((model) => model.key === current.key)) return modeModels
    const hiddenByPreference = !current.unavailable && !isModelVisible(
      getProviderModelVisibilityPreference(current.providerId),
      current.id,
    )
    if (hiddenByPreference) return modeModels
    return [...modeModels, current].sort(compareModels)
  })

  const groupedVisibleOptions = createMemo<ModelGroup[]>(() => {
    const groups = new Map<string, ModelGroup>()
    for (const model of visibleOptions()) {
      const existing = groups.get(model.providerId)
      if (existing) {
        existing.models.push(model)
      } else {
        groups.set(model.providerId, { providerId: model.providerId, providerName: model.providerName, models: [model] })
      }
    }

    return Array.from(groups.values())
  })

  const pickerOptions = createMemo<PickerOption[]>(() =>
    groupedVisibleOptions().flatMap((group) => [
      {
        type: "header" as const,
        key: `provider:${group.providerId}`,
        providerId: group.providerId,
        providerName: group.providerName,
        searchText: `${group.providerName} ${group.providerId}`,
      },
      ...group.models,
    ]),
  )

  const comboboxValue = createMemo(() => {
    const options = pickerOptions().filter((option): option is FlatModel => !isProviderHeaderOption(option))
    return resolvePickerValue(currentModelValue(), options)
  })

  const currentModelAccessibleLabel = createMemo(() => {
    const current = currentModelValue()
    if (!current) return currentModelLabel()
    return t("modelSelector.trigger.ariaLabel", {
      model: current.name,
      provider: current.providerName,
      id: `${current.providerId}/${current.id}`,
    })
  })

  const handleChange = async (value: PickerOption | null) => {
    if (!value || isProviderHeaderOption(value) || value.unavailable) return
    await props.onModelChange({ providerId: value.providerId, modelId: value.id })
  }

  const customFilter = (option: PickerOption, input: string) => {
    const query = input.trim().toLowerCase()
    if (!query) return true
    if (!isProviderHeaderOption(option)) return option.searchText.toLowerCase().includes(query)
    return visibleOptions().some((model) => model.providerId === option.providerId
      && model.searchText.toLowerCase().includes(query))
  }

  const restoreSelectedInput = () => {
    setInputValue(currentModelLabel())
    queueMicrotask(() => searchInputRef?.select())
  }

  const closePicker = () => {
    setIsOpen(false)
    restoreSelectedInput()
  }

  createEffect(() => {
    if (isOpen()) {
      setTimeout(() => {
        searchInputRef?.focus()
        searchInputRef?.select()
      }, 100)
    } else {
      setInputValue(currentModelLabel())
    }
  })

  const preventListboxPress = (event: PointerEvent | MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation?.()
    event.stopPropagation()
    suppressNextClose = true
    setTimeout(() => {
      suppressNextClose = false
    }, 0)
  }

  const canChooseFavoritesMode = createMemo(() => hasFavorites() || favoritesOnlyPreference())

  const toggleFavoritesOnly = () => {
    if (!canChooseFavoritesMode()) return
    if (searchActive()) return
    setFavoritesOnlyPreference(!favoritesOnlyPreference())
  }

  // The pressed state reports the stored choice, not the temporarily effective
  // list, so a mode kept without favorites is still visible and revocable.
  const favoritesToggleLabel = () => t(favoritesOnlyPreference()
    ? "modelSelector.favoritesOnly.showAll"
    : "modelSelector.favoritesOnly.toggle.ariaLabel")

  return (
    <div class="sidebar-selector">
      <Combobox<PickerOption>
        gutter={0}
        open={isOpen()}
        value={isOpen() ? openComboboxValue() : comboboxValue()}
        onChange={handleChange}
        onOpenChange={(next, triggerMode) => {
          if (!next && suppressNextClose) return
          if (next) setOpenComboboxValue(comboboxValue())
          setIsOpen(next)
          if (!next) restoreSelectedInput()
          else if (triggerMode !== "input") setInputValue("")
        }}
        onInputChange={setInputValue}
        noResetInputOnBlur
        options={pickerOptions()}
        optionValue="key"
        optionTextValue="searchText"
        optionLabel={(option) => isProviderHeaderOption(option)
          ? option.providerName
          : t("modelSelector.trigger.primary", { model: option.name })}
        optionDisabled={(option) => isProviderHeaderOption(option) || Boolean(option.unavailable)}
        placeholder={t("modelSelector.placeholder.search")}
        defaultFilter={customFilter}
        allowsEmptyCollection
        itemComponent={(itemProps) => {
          if (isProviderHeaderOption(itemProps.item.rawValue)) {
            const header = itemProps.item.rawValue
            return (
              <li class="selector-section" role="presentation">
                <span class="selector-section-title" title={header.providerId}>
                  {header.providerName}
                  {header.providerName !== header.providerId && <span dir="ltr"> · {header.providerId}</span>}
                </span>
              </li>
            )
          }

          const model = itemProps.item.rawValue
          const isFavorite = () => favoriteKeySet().has(model.key)
          return (
            <Combobox.Item
              item={itemProps.item}
              class="selector-option"
            >
              <>
                <div class="selector-option-content">
                  <Combobox.ItemLabel class="selector-option-label">{model.name}</Combobox.ItemLabel>
                  <Combobox.ItemDescription class="selector-option-description">
                    {model.providerName} • {model.providerId}/{model.id}
                  </Combobox.ItemDescription>
                </div>
                <Combobox.ItemIndicator class="selector-option-indicator">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </Combobox.ItemIndicator>
                {!model.unavailable && (
                  <button
                    type="button"
                    class="selector-option-star"
                    data-active={isFavorite()}
                    aria-label={
                      isFavorite()
                        ? t("modelSelector.favorite.remove")
                        : t("modelSelector.favorite.add")
                    }
                    onPointerDown={preventListboxPress}
                    onPointerUp={preventListboxPress}
                    onMouseDown={preventListboxPress}
                    onMouseUp={preventListboxPress}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      event.stopPropagation()
                      suppressNextClose = true
                      setTimeout(() => {
                        suppressNextClose = false
                      }, 0)
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleFavoriteModelPreference({
                        providerId: model.providerId,
                        modelId: model.id,
                      })
                    }}
                  >
                    <Star
                      class="w-4 h-4"
                      fill={isFavorite() ? "currentColor" : "none"}
                    />
                  </button>
                )}
              </>
            </Combobox.Item>
          )
        }}
      >
        <ComboboxInputValue value={inputValue()} />
        <Combobox.Control class="relative w-full" data-model-selector-control>
          <Combobox.Input class="sr-only" data-model-selector aria-label={currentModelAccessibleLabel()} />
          <Combobox.Trigger class="selector-trigger" aria-label={currentModelAccessibleLabel()} title={currentModelAccessibleLabel()}>
            <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
              <span class="selector-trigger-primary selector-trigger-primary--align-left">
                <span class="session-sidebar-selector-prefix">{t("modelSelector.trigger.primary", { model: "" }).trim()}</span>{" "}
                {currentModelName()}
              </span>
            </div>
            <Combobox.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content class="selector-popover session-sidebar-selector-popover">
            <div class="selector-search-container">
              <div class="selector-input-group">
                <Combobox.Input
                  ref={searchInputRef}
                  class="selector-search-input flex-1 min-w-0"
                  value={inputValue()}
                  placeholder={t("modelSelector.placeholder.search")}
                  aria-label={t("modelSelector.placeholder.search")}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") queueMicrotask(restoreSelectedInput)
                  }}
                />
                <button
                  type="button"
                  class="selector-favorites-toggle"
                  aria-label={favoritesToggleLabel()}
                  title={favoritesToggleLabel()}
                  aria-pressed={favoritesOnlyPreference()}
                  disabled={!canChooseFavoritesMode() || searchActive()}
                  data-active={favoritesOnlyPreference()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleFavoritesOnly()
                  }}
                >
                  <Star class="w-4 h-4" fill={favoritesOnlyPreference() ? "currentColor" : "none"} />
                </button>
              </div>
            </div>
            <Combobox.Listbox class="selector-listbox" />
            <div class="selector-footer">
              <button
                type="button"
                class="selector-option selector-option-action w-full"
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  closePicker()
                  setProvidersModalOpen(true)
                }}
              >
                <PlugZap class="w-4 h-4" />
                <span class="selector-option-label">{t("modelSelector.manageProviders")}</span>
              </button>
            </div>
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <ProviderManagerModal instanceId={props.instanceId} open={providersModalOpen()} onOpenChange={setProvidersModalOpen} />
    </div>
  )
}
