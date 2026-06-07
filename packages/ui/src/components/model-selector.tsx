import { Combobox } from "@kobalte/core/combobox"
import { createEffect, createMemo, createSignal } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown, PlugZap, Star } from "lucide-solid"
import type { Model } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { uiState, toggleFavoriteModelPreference } from "../stores/preferences"
import { ProviderManagerModal } from "./provider-auth/provider-manager-modal"
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

const isProviderHeaderOption = (option: PickerOption): option is ProviderHeaderOption => "type" in option && option.type === "header"

export default function ModelSelector(props: ModelSelectorProps) {
  const { t } = useI18n()
  const instanceProviders = () => providers().get(props.instanceId) || []
  const [isOpen, setIsOpen] = createSignal(false)
  const [manualAll, setManualAll] = createSignal(false)
  const [explicitFavorites, setExplicitFavorites] = createSignal(false)
  const [autoFavoritesEligibleAtOpen, setAutoFavoritesEligibleAtOpen] = createSignal(false)
  const [searchDirty, setSearchDirty] = createSignal(false)
  const [initialQuery, setInitialQuery] = createSignal("")
  const [initialQueryReady, setInitialQueryReady] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [providersModalOpen, setProvidersModalOpen] = createSignal(false)
  let triggerRef!: HTMLButtonElement
  let searchInputRef!: HTMLInputElement
  let listboxRef!: HTMLUListElement
  let suppressNextClose = false
  let wasFavoritesOnlyEnabled = false
  let wasCurrentModelFavorite = false

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch((error) => log.error("Failed to fetch providers", error))
    }
  })

  const allModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        providerName: p.name,
        key: `${m.providerId}/${m.id}`,
        searchText: `${m.name} ${p.name} ${m.providerId} ${m.id} ${m.providerId}/${m.id}`,
      })),
    ),
  )

  const sortedModels = createMemo<FlatModel[]>(() =>
    [...allModels()].sort((left, right) => {
      const providerComparison = compareIds(left.providerId, right.providerId)
      if (providerComparison !== 0) return providerComparison
      const nameComparison = compareIds(left.name, right.name)
      if (nameComparison !== 0) return nameComparison
      return compareIds(left.id, right.id)
    }),
  )

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

  const currentModelValue = createMemo(() =>
    allModels().find((m) => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId),
  )

  const currentModelIsFavorite = createMemo(() => {
    const current = props.currentModel
    return favoriteKeySet().has(`${current.providerId}/${current.modelId}`)
  })

  const currentModelKey = createMemo(() => {
    const current = props.currentModel
    return `${current.providerId}/${current.modelId}`
  })

  const searchActive = createMemo(() => {
    if (!searchDirty()) return false
    const next = inputValue().trim()
    return next.length > 0
  })

  const favoritesOnlyEnabled = createMemo(() => {
    if (searchActive()) return false
    if (manualAll()) return false
    if (!hasFavorites()) return false
    return explicitFavorites() || autoFavoritesEligibleAtOpen()
  })

  const visibleOptions = createMemo<FlatModel[]>(() => {
    if (!favoritesOnlyEnabled()) {
      return sortedModels()
    }
    return favoriteModels()
  })

  const groupedVisibleOptions = createMemo<ModelGroup[]>(() => {
    const query = searchActive() ? inputValue().trim().toLowerCase() : ""
    const groups = new Map<string, ModelGroup>()
    for (const model of visibleOptions()) {
      if (query && !model.searchText.toLowerCase().includes(query)) continue
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

  const handleChange = async (value: PickerOption | null) => {
    if (!value || isProviderHeaderOption(value)) return
    await props.onModelChange({ providerId: value.providerId, modelId: value.id })
  }

  const customFilter = () => true

  createEffect(() => {
    if (isOpen()) {
      setManualAll(false)
      setExplicitFavorites(false)
      setAutoFavoritesEligibleAtOpen(hasFavorites() && currentModelIsFavorite())
      setSearchDirty(false)
      setInitialQuery("")
      setInputValue("")
      setInitialQueryReady(false)
      setTimeout(() => {
        const seeded = searchInputRef?.value ?? ""
        setInitialQuery(seeded)
        setInputValue(seeded)
        setInitialQueryReady(true)
        searchInputRef?.focus()
        searchInputRef?.select()
      }, 100)
    } else {
      setInitialQueryReady(false)
      setSearchDirty(false)
      setAutoFavoritesEligibleAtOpen(false)
    }
  })

  createEffect(() => {
    if (!isOpen()) {
      wasFavoritesOnlyEnabled = favoritesOnlyEnabled()
      wasCurrentModelFavorite = currentModelIsFavorite()
      return
    }

    const nowFavoritesOnlyEnabled = favoritesOnlyEnabled()
    const nowCurrentModelFavorite = currentModelIsFavorite()

    if (wasFavoritesOnlyEnabled && !nowFavoritesOnlyEnabled && wasCurrentModelFavorite && !nowCurrentModelFavorite) {
      setTimeout(() => {
        const key = currentModelKey()
        const target = listboxRef?.querySelector(`[data-key="${key}"]`) as HTMLElement | null
        target?.scrollIntoView({ block: "nearest" })
      }, 0)
    }

    wasFavoritesOnlyEnabled = nowFavoritesOnlyEnabled
    wasCurrentModelFavorite = nowCurrentModelFavorite
  })

  const handleSearchInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const next = event.currentTarget.value
    setInputValue(next)
    if (!initialQueryReady()) return
    if (searchDirty()) return
    if (next !== initialQuery()) {
      setSearchDirty(true)
    }
  }

  const preventListboxPress = (event: PointerEvent | MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation?.()
    event.stopPropagation()
    suppressNextClose = true
    setTimeout(() => {
      suppressNextClose = false
    }, 0)
  }

  const toggleFavoritesOnly = () => {
    if (!hasFavorites()) return
    if (searchActive()) return

    if (favoritesOnlyEnabled()) {
      setManualAll(true)
      setExplicitFavorites(false)
      setAutoFavoritesEligibleAtOpen(false)
      return
    }

    setExplicitFavorites(true)
    setManualAll(false)
  }

  const showAllModels = () => {
    setManualAll(true)
    setExplicitFavorites(false)
    setAutoFavoritesEligibleAtOpen(false)
    setTimeout(() => searchInputRef?.focus(), 0)
  }

  return (
    <div class="sidebar-selector">
      <Combobox<PickerOption>
        open={isOpen()}
        value={currentModelValue()}
        onChange={handleChange}
        onOpenChange={(next) => {
          if (!next && suppressNextClose) return
          setIsOpen(next)
        }}
        options={pickerOptions()}
        optionValue="key"
        optionTextValue="searchText"
        optionLabel={(option) => (isProviderHeaderOption(option) ? option.providerName : option.name)}
        optionDisabled={isProviderHeaderOption}
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
              </>
            </Combobox.Item>
          )
        }}
      >
        <Combobox.Control class="relative w-full" data-model-selector-control>
          <Combobox.Input class="sr-only" data-model-selector />
          <Combobox.Trigger
            ref={triggerRef}
            class="selector-trigger"
          >
            <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
              <span class="selector-trigger-primary selector-trigger-primary--align-left">
                {t("modelSelector.trigger.primary", { model: currentModelValue()?.name ?? t("modelSelector.none") })}
              </span>
          {currentModelValue() && (
                <span class="selector-trigger-secondary" dir="ltr">
                  {currentModelValue()!.providerId}/{currentModelValue()!.id}
                </span>
              )}
            </div>
            <Combobox.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content class="selector-popover">
            <div class="selector-search-container">
              <div class="selector-input-group">
                <Combobox.Input
                  ref={searchInputRef}
                  class="selector-search-input flex-1 min-w-0"
                  placeholder={t("modelSelector.placeholder.search")}
                  onInput={handleSearchInput}
                />
                <button
                  type="button"
                  class="selector-favorites-toggle"
                  aria-label={t("modelSelector.favoritesOnly.toggle.ariaLabel")}
                  aria-pressed={favoritesOnlyEnabled()}
                  disabled={!hasFavorites() || searchActive()}
                  data-active={favoritesOnlyEnabled()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleFavoritesOnly()
                  }}
                >
                  <Star class="w-4 h-4" fill={favoritesOnlyEnabled() ? "currentColor" : "none"} />
                </button>
              </div>
            </div>
            <Combobox.Listbox ref={listboxRef} class="selector-listbox" />
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
                  setIsOpen(false)
                  setProvidersModalOpen(true)
                }}
              >
                <PlugZap class="w-4 h-4" />
                <span class="selector-option-label">{t("modelSelector.manageProviders")}</span>
              </button>
              <button
                type="button"
                class="selector-option selector-option-action w-full"
                style={{ display: favoritesOnlyEnabled() && !searchActive() ? "flex" : "none" }}
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
                  showAllModels()
                }}
              >
                <span class="selector-option-label">{t("modelSelector.favoritesOnly.showAll")}</span>
              </button>
            </div>
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <ProviderManagerModal instanceId={props.instanceId} open={providersModalOpen()} onOpenChange={setProvidersModalOpen} />
    </div>
  )
}
