import { Popover } from "@kobalte/core/popover"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown, ChevronRight, Check, Star } from "lucide-solid"
import type { Model } from "../types/session"
import { getLogger } from "../lib/logger"
import { isModelFavorite, toggleModelFavorite, getModelFavorites } from "../stores/preferences"
import { cn } from "../lib/cn"
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

interface ProviderGroup {
  provider: string
  providerName: string
  options: FlatModel[]
}

export default function ModelSelector(props: ModelSelectorProps) {
  const instanceProviders = () => providers().get(props.instanceId) || []
  const [isOpen, setIsOpen] = createSignal(false)
  const [expandedProvider, setExpandedProvider] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  let searchInputRef!: HTMLInputElement

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch((error) => log.error("Failed to fetch providers", error))
    }
  })

  const allModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      (p.models || []).filter(Boolean).map((m) => ({
        ...m,
        providerName: p.name ?? "Unknown",
        key: `${m.providerId ?? "?"}/${m.id ?? "?"}`,
        searchText: `${m.name ?? ""} ${p.name ?? ""} ${m.providerId ?? ""} ${m.id ?? ""} ${m.providerId ?? ""}/${m.id ?? ""}`.toLowerCase(),
      })),
    ),
  )

  // Get favorite models
  const favoriteModels = createMemo<FlatModel[]>(() => {
    const favorites = getModelFavorites()
    return allModels().filter(m => favorites.includes(m.key))
  })

  // Group models by provider for display
  const groupedModels = createMemo<ProviderGroup[]>(() => {
    const models = allModels()
    if (!models || models.length === 0) return []

    const groups = new Map<string, ProviderGroup>()
    for (const model of models) {
      if (!model || !model.providerId) continue
      const existing = groups.get(model.providerId)
      if (existing) {
        existing.options.push(model)
      } else {
        groups.set(model.providerId, {
          provider: model.providerId,
          providerName: model.providerName ?? "Unknown",
          options: [model],
        })
      }
    }
    return Array.from(groups.values()).filter(g => g && g.options && g.options.length > 0)
  })

  // Filter groups and models based on search query
  const filteredGroups = createMemo<ProviderGroup[]>(() => {
    const query = searchQuery().toLowerCase().trim()
    if (!query) return groupedModels()

    return groupedModels()
      .map(group => {
        // Check if provider name matches
        const providerMatches = group.providerName.toLowerCase().includes(query) ||
          group.provider.toLowerCase().includes(query)

        // Filter models that match the query
        const matchingModels = group.options.filter(model =>
          model.searchText.includes(query)
        )

        // Include group if provider matches (show all models) or if any models match
        if (providerMatches) {
          return group // Show all models when provider matches
        } else if (matchingModels.length > 0) {
          return { ...group, options: matchingModels }
        }
        return null
      })
      .filter((g): g is ProviderGroup => g !== null)
  })

  const currentModelValue = createMemo(() =>
    allModels().find((m) => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId),
  )

  const handleModelSelect = async (model: FlatModel) => {
    await props.onModelChange({ providerId: model.providerId, modelId: model.id })
    setIsOpen(false)
    setExpandedProvider(null)
    setSearchQuery("")
  }

  const toggleProvider = (providerId: string) => {
    setExpandedProvider(prev => prev === providerId ? null : providerId)
  }

  createEffect(() => {
    if (isOpen()) {
      // Start collapsed, focus search
      setExpandedProvider(null)
      setTimeout(() => {
        searchInputRef?.focus()
      }, 100)
    } else {
      setSearchQuery("")
    }
  })

  // Auto-expand when searching
  createEffect(() => {
    const query = searchQuery()
    if (query.trim()) {
      // When searching, expand all matching groups
      const firstMatch = filteredGroups()[0]
      if (firstMatch) {
        setExpandedProvider(firstMatch.provider)
      }
    }
  })

  // Guard against rendering before data is loaded
  if (allModels().length === 0) {
    return (
      <div class="flex flex-col gap-1 w-full">
        <label class="text-xs font-semibold uppercase tracking-wide mb-1.5 block text-muted-foreground">Model</label>
        <div class="inline-flex items-center justify-between gap-2 px-2 py-1 border rounded outline-none transition-colors text-xs min-w-[180px] bg-background border-border text-foreground">
          <span class="text-sm font-medium truncate text-foreground">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-1.5 w-full">
      <label class="text-xs font-semibold uppercase tracking-wide block text-muted-foreground">Model</label>
      <Popover open={isOpen()} onOpenChange={setIsOpen}>
        <Popover.Trigger class="w-full inline-flex items-center justify-between gap-2 px-2 py-1.5 border rounded outline-none transition-colors text-xs bg-background border-border text-foreground hover:bg-accent focus:ring-2 focus:ring-info">
          <div class="flex flex-col min-w-0 items-start">
            <span class="text-sm font-medium truncate text-foreground text-left w-full">
              {currentModelValue()?.name ?? "Select model"}
            </span>
            {currentModelValue() && (
              <span class="text-xs text-left truncate text-muted-foreground">
                {currentModelValue()!.providerId}/{currentModelValue()!.id}
              </span>
            )}
          </div>
          <ChevronDown class="w-3 h-3 flex-shrink-0 text-muted-foreground" />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content class="rounded-md shadow-lg overflow-hidden min-w-[320px] max-w-[400px] bg-background border border-border z-[2200]">
            <div class="p-2 border-b border-border">
              <input
                ref={searchInputRef}
                type="text"
                class="w-full px-3 py-1.5 text-xs border rounded outline-none transition-colors bg-background border-border text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-info"
                placeholder="Search providers or models..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
            </div>

            <div class="max-h-80 overflow-auto p-1">
              {/* Favorites section */}
              <Show when={favoriteModels().length > 0 && !searchQuery().trim()}>
                <div class="mb-2 pb-2 border-b border-border">
                  <div class="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
                    <Star class="w-3 h-3 fill-current" />
                    <span>Favorites</span>
                  </div>
                  <div class="space-y-0.5">
                    <For each={favoriteModels()}>
                      {(model) => {
                        const isSelected = () =>
                          model.providerId === props.currentModel.providerId &&
                          model.id === props.currentModel.modelId

                        return (
                          <div class="flex items-center gap-1">
                            <button
                              type="button"
                              class={cn(
                                "flex-1 w-full flex items-center gap-2 px-2 py-1.5 text-left rounded cursor-pointer transition-colors text-foreground hover:bg-accent",
                                isSelected() && "bg-accent"
                              )}
                              onClick={() => handleModelSelect(model)}
                            >
                              <div class="flex-1 min-w-0 flex flex-col">
                                <span class="text-sm truncate text-foreground">{model.name}</span>
                                <span class="text-xs truncate text-muted-foreground">{model.providerName}</span>
                              </div>
                              <Show when={isSelected()}>
                                <Check class="w-4 h-4 text-success" />
                              </Show>
                            </button>
                            <button
                              type="button"
                              class="p-1.5 rounded transition-all flex-shrink-0 text-warning"
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleModelFavorite(model.key)
                              }}
                              title="Remove from favorites"
                            >
                              <Star class="w-3.5 h-3.5 fill-current" />
                            </button>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              <For each={filteredGroups()}>
                {(group) => {
                  const isExpanded = () => expandedProvider() === group.provider
                  const hasCurrentModel = () => group.options.some(
                    m => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId
                  )

                  return (
                    <div class="mb-0.5">
                      <button
                        type="button"
                        class={cn(
                          "w-full flex items-center gap-2 px-2 py-2 text-left rounded cursor-pointer transition-colors text-foreground hover:bg-accent",
                          isExpanded() && "bg-secondary",
                          hasCurrentModel() && !isExpanded() && "bg-accent"
                        )}
                        onClick={() => toggleProvider(group.provider)}
                      >
                        <span class="flex-shrink-0 flex items-center justify-center w-4 h-4 text-muted-foreground">
                          {isExpanded() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
                        </span>
                        <span class="flex-1 font-medium text-sm truncate text-foreground">{group.providerName}</span>
                        <span class="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{group.options.length}</span>
                        <Show when={hasCurrentModel() && !isExpanded()}>
                          <Check class="w-3 h-3 text-success" />
                        </Show>
                      </button>

                      <Show when={isExpanded()}>
                        <div class="ml-4 pl-2 border-l border-border/50 py-1">
                          <For each={group.options}>
                            {(model) => {
                              const isSelected = () =>
                                model.providerId === props.currentModel.providerId &&
                                model.id === props.currentModel.modelId
                              const isFavorite = () => isModelFavorite(model.key)

                              return (
                                <div class="flex items-center gap-1">
                                  <button
                                    type="button"
                                    class={cn(
                                      "w-full flex items-center gap-2 px-2 py-1.5 text-left rounded cursor-pointer transition-colors text-foreground hover:bg-accent",
                                      isSelected() && "bg-accent"
                                    )}
                                    onClick={() => handleModelSelect(model)}
                                  >
                                    <div class="flex-1 min-w-0 flex flex-col">
                                      <span class="text-sm truncate text-foreground">{model.name}</span>
                                      <span class="text-xs truncate text-muted-foreground">{model.id}</span>
                                    </div>
                                    <Show when={isSelected()}>
                                      <Check class="w-4 h-4 text-success" />
                                    </Show>
                                  </button>
                                  <button
                                    type="button"
                                    class={cn(
                                      "p-1.5 rounded transition-all flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-warning hover:bg-accent",
                                      isFavorite() && "opacity-100 text-warning"
                                    )}
                                    style={{ opacity: isFavorite() ? 1 : undefined }}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleModelFavorite(model.key)
                                    }}
                                    title={isFavorite() ? "Remove from favorites" : "Add to favorites"}
                                  >
                                    <Star class={cn("w-3.5 h-3.5", isFavorite() && "fill-current")} />
                                  </button>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>

              <Show when={filteredGroups().length === 0}>
                <div class="p-4 text-center text-sm text-muted-foreground">
                  No models found matching "{searchQuery()}"
                </div>
              </Show>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </div>
  )
}
