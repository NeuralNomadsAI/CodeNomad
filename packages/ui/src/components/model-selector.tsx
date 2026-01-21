import { Popover } from "@kobalte/core/popover"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown, ChevronRight, Check } from "lucide-solid"
import type { Model } from "../types/session"
import { getLogger } from "../lib/logger"
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
      <div class="sidebar-selector">
        <label class="selector-label">Model</label>
        <div class="selector-trigger">
          <span class="selector-trigger-primary">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div class="sidebar-selector">
      <label class="selector-label">Model</label>
      <Popover open={isOpen()} onOpenChange={setIsOpen}>
        <Popover.Trigger class="selector-trigger">
          <div class="selector-trigger-label selector-trigger-label--stacked">
            <span class="selector-trigger-primary selector-trigger-primary--align-left">
              {currentModelValue()?.name ?? "Select model"}
            </span>
            {currentModelValue() && (
              <span class="selector-trigger-secondary">
                {currentModelValue()!.providerId}/{currentModelValue()!.id}
              </span>
            )}
          </div>
          <ChevronDown class="w-3 h-3 selector-trigger-icon" />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content class="selector-popover model-selector-popover">
            <div class="selector-search-container">
              <input
                ref={searchInputRef}
                type="text"
                class="selector-search-input"
                placeholder="Search providers or models..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
            </div>

            <div class="model-selector-groups">
              <For each={filteredGroups()}>
                {(group) => {
                  const isExpanded = () => expandedProvider() === group.provider
                  const hasCurrentModel = () => group.options.some(
                    m => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId
                  )

                  return (
                    <div class="model-selector-group">
                      <button
                        type="button"
                        class="model-selector-provider"
                        classList={{
                          "model-selector-provider--expanded": isExpanded(),
                          "model-selector-provider--has-selection": hasCurrentModel() && !isExpanded()
                        }}
                        onClick={() => toggleProvider(group.provider)}
                      >
                        <span class="model-selector-provider-icon">
                          {isExpanded() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
                        </span>
                        <span class="model-selector-provider-name">{group.providerName}</span>
                        <span class="model-selector-provider-count">{group.options.length}</span>
                        <Show when={hasCurrentModel() && !isExpanded()}>
                          <Check class="w-3 h-3 text-green-400" />
                        </Show>
                      </button>

                      <Show when={isExpanded()}>
                        <div class="model-selector-models">
                          <For each={group.options}>
                            {(model) => {
                              const isSelected = () =>
                                model.providerId === props.currentModel.providerId &&
                                model.id === props.currentModel.modelId

                              return (
                                <button
                                  type="button"
                                  class="model-selector-model"
                                  classList={{ "model-selector-model--selected": isSelected() }}
                                  onClick={() => handleModelSelect(model)}
                                >
                                  <div class="model-selector-model-content">
                                    <span class="model-selector-model-name">{model.name}</span>
                                    <span class="model-selector-model-id">{model.id}</span>
                                  </div>
                                  <Show when={isSelected()}>
                                    <Check class="w-4 h-4 text-green-400" />
                                  </Show>
                                </button>
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
                <div class="model-selector-empty">
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
