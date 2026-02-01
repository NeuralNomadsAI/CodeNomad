import { Component, createSignal, createMemo, createEffect, For, Show, onMount } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { Search, X, ChevronDown, Loader2, Zap, Brain, Wrench } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
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
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/50" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="w-full max-w-lg rounded-lg flex flex-col bg-background border border-border shadow-xl max-h-[80vh]">
            {/* Header */}
            <div class="flex items-center justify-between px-4 py-3 border-b border-border">
              <Dialog.Title class="text-base font-semibold text-foreground">Select Model</Dialog.Title>
              <Dialog.CloseButton
                class="p-1 rounded transition-colors text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={handleCancel}
              >
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            {/* Search */}
            <div class="relative flex items-center px-4 py-3 border-b border-border">
              <Search class="absolute left-7 w-4 h-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                class="w-full pl-8 pr-8 py-2 text-sm rounded-md border border-border bg-secondary text-foreground outline-none placeholder:text-muted-foreground focus:border-info"
                placeholder="Search models..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
              <Show when={searchQuery()}>
                <button
                  type="button"
                  class="absolute right-7 p-1 rounded transition-colors text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setSearchQuery("")}
                >
                  <X class="w-4 h-4" />
                </button>
              </Show>
            </div>

            {/* Search Results */}
            <Show when={searchQuery().trim()}>
              <div class="flex flex-col overflow-y-auto max-h-[300px] border-b border-border">
                <Show when={isModelsLoading()}>
                  <div class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 class="w-5 h-5 animate-spin" />
                    <span>Loading models...</span>
                  </div>
                </Show>
                <Show when={!isModelsLoading() && searchResults().length === 0}>
                  <div class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">No models found</div>
                </Show>
                <For each={searchResults()}>
                  {(result) => (
                    <button
                      type="button"
                      class="flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-border last:border-b-0 hover:bg-accent"
                      onClick={() => handleSearchResultSelect(result)}
                    >
                      <img
                        src={getProviderLogoUrl(result.provider.id)}
                        alt={result.provider.name}
                        class="w-6 h-6 rounded flex-shrink-0 brightness-0 invert"
                        onError={(e) => {
                          e.currentTarget.style.display = "none"
                        }}
                      />
                      <div class="flex flex-col flex-1 min-w-0">
                        <span class="text-sm font-medium truncate text-foreground">{result.model.name}</span>
                        <span class="text-xs truncate text-muted-foreground">{result.provider.name}</span>
                      </div>
                      <span class="text-xs font-mono flex-shrink-0 text-muted-foreground">
                        {formatModelCost(result.model.cost)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            {/* Provider/Model Selection */}
            <Show when={!searchQuery().trim()}>
              <div class="flex flex-col gap-4 p-4">
                {/* Provider Select */}
                <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Provider</label>
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
                        <Select.Item
                          item={itemProps.item}
                          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors text-foreground hover:bg-accent data-[highlighted]:bg-accent data-[selected]:bg-accent"
                        >
                          <Select.ItemIndicator class="w-4 text-center flex-shrink-0 text-info">
                            ✓
                          </Select.ItemIndicator>
                          <img
                            src={getProviderLogoUrl(itemProps.item.rawValue)}
                            alt=""
                            class="w-5 h-5 rounded flex-shrink-0 brightness-0 invert"
                            onError={(e) => {
                              e.currentTarget.style.display = "none"
                            }}
                          />
                          <Select.ItemLabel>{provider?.name || itemProps.item.rawValue}</Select.ItemLabel>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger class="flex items-center justify-between w-full px-3 py-2 text-sm rounded-md border border-border bg-secondary text-foreground transition-colors hover:border-info disabled:opacity-50 disabled:cursor-not-allowed">
                      <Select.Value<string>>
                        {(state) => {
                          const provider = providers().find(p => p.id === state.selectedOption())
                          return (
                            <div class="flex items-center gap-2">
                              <Show when={provider}>
                                <img
                                  src={getProviderLogoUrl(provider!.id)}
                                  alt=""
                                  class="w-5 h-5 rounded brightness-0 invert"
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
                      <Select.Icon class="text-muted-foreground">
                        <ChevronDown class="w-4 h-4" />
                      </Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class="rounded-md border border-border overflow-hidden z-50 bg-background shadow-lg">
                        <Select.Listbox class="max-h-60 overflow-y-auto py-1" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>

                {/* Model Select */}
                <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Model</label>
                  <Select
                    value={selectedModelId()}
                    onChange={(value) => value && setSelectedModelId(value)}
                    options={currentProviderModels().map(m => m.id)}
                    placeholder="Select model..."
                    disabled={!selectedProviderId()}
                    itemComponent={(itemProps) => {
                      const model = currentProviderModels().find(m => m.id === itemProps.item.rawValue)
                      return (
                        <Select.Item
                          item={itemProps.item}
                          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors text-foreground hover:bg-accent data-[highlighted]:bg-accent data-[selected]:bg-accent"
                        >
                          <Select.ItemIndicator class="w-4 text-center flex-shrink-0 text-info">
                            ✓
                          </Select.ItemIndicator>
                          <div class="flex items-center justify-between flex-1 gap-2">
                            <span class="truncate">{model?.name || itemProps.item.rawValue}</span>
                            <span class="text-xs font-mono flex-shrink-0 text-muted-foreground">
                              {formatModelCost(model?.cost)}
                            </span>
                          </div>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger
                      class="flex items-center justify-between w-full px-3 py-2 text-sm rounded-md border border-border bg-secondary text-foreground transition-colors hover:border-info disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={!selectedProviderId()}
                    >
                      <Select.Value<string>>
                        {(state) => {
                          const model = currentProviderModels().find(m => m.id === state.selectedOption())
                          return model?.name || "Select model..."
                        }}
                      </Select.Value>
                      <Select.Icon class="text-muted-foreground">
                        <ChevronDown class="w-4 h-4" />
                      </Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class="rounded-md border border-border overflow-hidden z-50 bg-background shadow-lg">
                        <Select.Listbox class="max-h-60 overflow-y-auto py-1" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>

                {/* Model Info */}
                <Show when={selectedModel()}>
                  <div class="p-3 rounded-lg bg-secondary">
                    <div class="flex items-center justify-between py-1.5 border-b border-border">
                      <span class="text-xs text-muted-foreground">Context / Output</span>
                      <span class="text-xs font-mono text-muted-foreground">
                        {formatModelLimit(selectedModel()?.limit)}
                      </span>
                    </div>
                    <div class="flex items-center justify-between py-1.5">
                      <span class="text-xs text-muted-foreground">Pricing (per 1M tokens)</span>
                      <span class="text-xs font-mono text-muted-foreground">
                        {formatModelCost(selectedModel()?.cost)}
                      </span>
                    </div>
                    <div class="flex items-center gap-2 pt-2 mt-2 border-t border-border">
                      <Show when={selectedModel()?.reasoning}>
                        <span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-background text-muted-foreground" title="Reasoning">
                          <Brain class="w-3.5 h-3.5" /> Reasoning
                        </span>
                      </Show>
                      <Show when={selectedModel()?.tool_call}>
                        <span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-background text-muted-foreground" title="Tool Use">
                          <Wrench class="w-3.5 h-3.5" /> Tools
                        </span>
                      </Show>
                      <Show when={selectedModel()?.attachment}>
                        <span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-background text-muted-foreground" title="Attachments">
                          <Zap class="w-3.5 h-3.5" /> Vision
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Error state */}
                <Show when={getModelsFetchError()}>
                  <div class="text-xs p-2 rounded bg-destructive/10 text-destructive">
                    Failed to load models. Using cached data if available.
                  </div>
                </Show>
              </div>
            </Show>

            {/* Footer */}
            <div class="flex justify-end gap-2 px-4 py-3 border-t border-border">
              <Button
                variant="secondary"
                onClick={handleCancel}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!selectedProviderId() || !selectedModelId()}
              >
                Select
              </Button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default ModelSelectorModal
