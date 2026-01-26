import { Combobox } from "@kobalte/core/combobox"
import { createEffect, createMemo, createSignal } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown, Star } from "lucide-solid"
import type { Model } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { preferences, toggleFavoriteModelPreference } from "../stores/preferences"
import Kbd from "./kbd"
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

  const favoriteKeySet = createMemo(() => {
    const result = new Set<string>()
    for (const item of preferences().modelFavorites ?? []) {
      if (item.providerId && item.modelId) {
        result.add(`${item.providerId}/${item.modelId}`)
      }
    }
    return result
  })

  const favoriteModels = createMemo<FlatModel[]>(() => {
    const keys = favoriteKeySet()
    if (keys.size === 0) return []
    return allModels().filter((m) => keys.has(m.key))
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
      return allModels()
    }
    return favoriteModels()
  })

  const handleChange = async (value: FlatModel | null) => {
    if (!value) return
    await props.onModelChange({ providerId: value.providerId, modelId: value.id })
  }

  const customFilter = (option: FlatModel, rawInput: string) => {
    if (!searchDirty()) return true
    return option.searchText.toLowerCase().includes(rawInput.toLowerCase())
  }

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
      <Combobox<FlatModel>
        open={isOpen()}
        value={currentModelValue()}
        onChange={handleChange}
        onOpenChange={(next) => {
          if (!next && suppressNextClose) return
          setIsOpen(next)
        }}
        options={visibleOptions()}
        optionValue="key"
        optionTextValue="searchText"
        optionLabel="name"
        placeholder={t("modelSelector.placeholder.search")}
        defaultFilter={customFilter}
        allowsEmptyCollection
        itemComponent={(itemProps) => {
          const isFavorite = () => favoriteKeySet().has(itemProps.item.rawValue.key)
          return (
            <Combobox.Item
              item={itemProps.item}
              class="selector-option"
            >
              <>
                <div class="selector-option-content">
                  <Combobox.ItemLabel class="selector-option-label">{itemProps.item.rawValue.name}</Combobox.ItemLabel>
                  <Combobox.ItemDescription class="selector-option-description">
                    {itemProps.item.rawValue.providerName} • {itemProps.item.rawValue.providerId}/{itemProps.item.rawValue.id}
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
                      providerId: itemProps.item.rawValue.providerId,
                      modelId: itemProps.item.rawValue.id,
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
                <span class="selector-trigger-secondary">
                  {currentModelValue()!.providerId}/{currentModelValue()!.id}
                </span>
              )}
            </div>
            <span class="selector-trigger-hint selector-trigger-hint--top" aria-hidden="true">
              <Kbd shortcut="cmd+shift+m" />
            </span>
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
    </div>
  )
}
