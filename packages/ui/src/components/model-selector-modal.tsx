import { Component, createSignal, createMemo, createEffect, For, Show, onMount } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { Search, X, ChevronDown, Loader2, Zap, Brain, Wrench } from "lucide-solid"
import {
  fetchModelsData,
  getAllProviders,
  getProviderModels,
  getProviderLogoUrl,
  searchModels,
  formatModelCost,
  formatModelLimit,
  getPopularProviders,
  isModelsLoading,
  getModelsFetchError,
  type ModelsDevProvider,
  type ModelsDevModel,
  type SearchResult,
} from "../lib/models-api"

interface ModelSelectorModalProps {
  open: boolean
  currentProviderId: string
  currentModelId: string
  onSelect: (providerId: string, modelId: string) => void
  onCancel: () => void
}

const ModelSelectorModal: Component<ModelSelectorModalProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedProviderId, setSelectedProviderId] = createSignal("")
  const [selectedModelId, setSelectedModelId] = createSignal("")
  let searchInputRef: HTMLInputElement | undefined

  // Fetch models data on mount
  onMount(() => {
    fetchModelsData()
  })

  // Initialize selection when modal opens
  createEffect(() => {
    if (props.open) {
      setSelectedProviderId(props.currentProviderId)
      setSelectedModelId(props.currentModelId)
      setSearchQuery("")
      // Focus search input
      setTimeout(() => searchInputRef?.focus(), 100)
    }
  })

  const providers = createMemo(() => getAllProviders())
  const popularProviders = createMemo(() => getPopularProviders())

  const currentProviderModels = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return []
    return getProviderModels(providerId)
  })

  const searchResults = createMemo((): SearchResult[] => {
    const query = searchQuery()
    if (!query.trim()) return []
    return searchModels(query, 15)
  })

  const selectedProvider = createMemo(() => {
    const providerId = selectedProviderId()
    return providers().find(p => p.id === providerId)
  })

  const selectedModel = createMemo(() => {
    const modelId = selectedModelId()
    return currentProviderModels().find(m => m.id === modelId)
  })

  const handleSearchResultSelect = (result: SearchResult) => {
    setSelectedProviderId(result.provider.id)
    setSelectedModelId(result.model.id)
    setSearchQuery("")
  }

  const handleConfirm = () => {
    const providerId = selectedProviderId()
    const modelId = selectedModelId()
    if (providerId && modelId) {
      props.onSelect(providerId, modelId)
    }
  }

  const handleCancel = () => {
    props.onCancel()
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && handleCancel()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="model-selector-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="model-selector-modal">
            {/* Header */}
            <div class="model-selector-header">
              <Dialog.Title class="model-selector-title">Select Model</Dialog.Title>
              <Dialog.CloseButton class="model-selector-close" onClick={handleCancel}>
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            {/* Search */}
            <div class="model-selector-search">
              <Search class="model-selector-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                class="model-selector-search-input"
                placeholder="Search models..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
              <Show when={searchQuery()}>
                <button
                  type="button"
                  class="model-selector-search-clear"
                  onClick={() => setSearchQuery("")}
                >
                  <X class="w-4 h-4" />
                </button>
              </Show>
            </div>

            {/* Search Results */}
            <Show when={searchQuery().trim()}>
              <div class="model-selector-search-results">
                <Show when={isModelsLoading()}>
                  <div class="model-selector-loading">
                    <Loader2 class="w-5 h-5 animate-spin" />
                    <span>Loading models...</span>
                  </div>
                </Show>
                <Show when={!isModelsLoading() && searchResults().length === 0}>
                  <div class="model-selector-empty">No models found</div>
                </Show>
                <For each={searchResults()}>
                  {(result) => (
                    <button
                      type="button"
                      class="model-selector-result"
                      onClick={() => handleSearchResultSelect(result)}
                    >
                      <img
                        src={getProviderLogoUrl(result.provider.id)}
                        alt={result.provider.name}
                        class="model-selector-result-logo"
                        onError={(e) => {
                          e.currentTarget.style.display = "none"
                        }}
                      />
                      <div class="model-selector-result-info">
                        <span class="model-selector-result-name">{result.model.name}</span>
                        <span class="model-selector-result-provider">{result.provider.name}</span>
                      </div>
                      <span class="model-selector-result-cost">
                        {formatModelCost(result.model.cost)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            {/* Provider/Model Selection */}
            <Show when={!searchQuery().trim()}>
              <div class="model-selector-body">
                {/* Provider Select */}
                <div class="model-selector-field">
                  <label class="model-selector-label">Provider</label>
                  <Select
                    value={selectedProviderId()}
                    onChange={(value) => {
                      if (value) {
                        setSelectedProviderId(value)
                        setSelectedModelId("")
                      }
                    }}
                    options={providers().map(p => p.id)}
                    placeholder="Select provider..."
                    itemComponent={(itemProps) => {
                      const provider = providers().find(p => p.id === itemProps.item.rawValue)
                      return (
                        <Select.Item item={itemProps.item} class="model-selector-option">
                          <Select.ItemIndicator class="model-selector-option-indicator">
                            ✓
                          </Select.ItemIndicator>
                          <img
                            src={getProviderLogoUrl(itemProps.item.rawValue)}
                            alt=""
                            class="model-selector-option-logo"
                            onError={(e) => {
                              e.currentTarget.style.display = "none"
                            }}
                          />
                          <Select.ItemLabel>{provider?.name || itemProps.item.rawValue}</Select.ItemLabel>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger class="model-selector-trigger">
                      <Select.Value<string>>
                        {(state) => {
                          const provider = providers().find(p => p.id === state.selectedOption())
                          return (
                            <div class="model-selector-trigger-content">
                              <Show when={provider}>
                                <img
                                  src={getProviderLogoUrl(provider!.id)}
                                  alt=""
                                  class="model-selector-trigger-logo"
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none"
                                  }}
                                />
                              </Show>
                              <span>{provider?.name || "Select provider..."}</span>
                            </div>
                          )
                        }}
                      </Select.Value>
                      <Select.Icon class="model-selector-trigger-icon">
                        <ChevronDown class="w-4 h-4" />
                      </Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class="model-selector-dropdown">
                        <Select.Listbox class="model-selector-listbox" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>

                {/* Model Select */}
                <div class="model-selector-field">
                  <label class="model-selector-label">Model</label>
                  <Select
                    value={selectedModelId()}
                    onChange={(value) => value && setSelectedModelId(value)}
                    options={currentProviderModels().map(m => m.id)}
                    placeholder="Select model..."
                    disabled={!selectedProviderId()}
                    itemComponent={(itemProps) => {
                      const model = currentProviderModels().find(m => m.id === itemProps.item.rawValue)
                      return (
                        <Select.Item item={itemProps.item} class="model-selector-option">
                          <Select.ItemIndicator class="model-selector-option-indicator">
                            ✓
                          </Select.ItemIndicator>
                          <div class="model-selector-option-content">
                            <span class="model-selector-option-name">{model?.name || itemProps.item.rawValue}</span>
                            <span class="model-selector-option-meta">
                              {formatModelCost(model?.cost)}
                            </span>
                          </div>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger class="model-selector-trigger" disabled={!selectedProviderId()}>
                      <Select.Value<string>>
                        {(state) => {
                          const model = currentProviderModels().find(m => m.id === state.selectedOption())
                          return model?.name || "Select model..."
                        }}
                      </Select.Value>
                      <Select.Icon class="model-selector-trigger-icon">
                        <ChevronDown class="w-4 h-4" />
                      </Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class="model-selector-dropdown">
                        <Select.Listbox class="model-selector-listbox" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>

                {/* Model Info */}
                <Show when={selectedModel()}>
                  <div class="model-selector-info">
                    <div class="model-selector-info-row">
                      <span class="model-selector-info-label">Context / Output</span>
                      <span class="model-selector-info-value">
                        {formatModelLimit(selectedModel()?.limit)}
                      </span>
                    </div>
                    <div class="model-selector-info-row">
                      <span class="model-selector-info-label">Pricing (per 1M tokens)</span>
                      <span class="model-selector-info-value">
                        {formatModelCost(selectedModel()?.cost)}
                      </span>
                    </div>
                    <div class="model-selector-info-features">
                      <Show when={selectedModel()?.reasoning}>
                        <span class="model-selector-feature" title="Reasoning">
                          <Brain class="w-3.5 h-3.5" /> Reasoning
                        </span>
                      </Show>
                      <Show when={selectedModel()?.tool_call}>
                        <span class="model-selector-feature" title="Tool Use">
                          <Wrench class="w-3.5 h-3.5" /> Tools
                        </span>
                      </Show>
                      <Show when={selectedModel()?.attachment}>
                        <span class="model-selector-feature" title="Attachments">
                          <Zap class="w-3.5 h-3.5" /> Vision
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Error state */}
                <Show when={getModelsFetchError()}>
                  <div class="model-selector-error">
                    Failed to load models. Using cached data if available.
                  </div>
                </Show>
              </div>
            </Show>

            {/* Footer */}
            <div class="model-selector-footer">
              <button
                type="button"
                class="model-selector-button model-selector-button-secondary"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                class="model-selector-button model-selector-button-primary"
                onClick={handleConfirm}
                disabled={!selectedProviderId() || !selectedModelId()}
              >
                Select
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default ModelSelectorModal
