import { Component, For, Show, createSignal, createMemo, onMount } from "solid-js"
import { Search, Brain, Wrench, Eye, Zap, Star, Filter, ChevronRight, Settings } from "lucide-solid"
import {
  fetchModelsData,
  getAllProviders,
  getProviderModels,
  getProviderLogoUrl,
  formatModelCost,
  formatModelLimit,
  type ModelsDevProvider,
  type ModelsDevModel,
} from "../lib/models-api"
import { cn } from "../lib/cn"
import { Badge, Button, Input, Separator } from "./ui"

interface ModelCatalogPanelProps {
  connectedProviderIds: Set<string>
  onSelectModel?: (providerId: string, modelId: string) => void
  onConfigureProvider?: (providerId: string) => void
}

const ModelCatalogPanel: Component<ModelCatalogPanelProps> = (props) => {
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [showConnectedOnly, setShowConnectedOnly] = createSignal(false)

  onMount(() => {
    fetchModelsData()
  })

  // Get all providers, filtered by search query and optionally to connected only
  const providers = createMemo(() => {
    let all = getAllProviders()

    // Filter by search query (matches provider name or any model name)
    const query = searchQuery().toLowerCase().trim()
    if (query) {
      all = all.filter(p => {
        // Match provider name
        if (p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)) {
          return true
        }
        // Match any model in this provider
        const models = Object.values(p.models || {})
        return models.some(m =>
          m.name.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query)
        )
      })
    }

    // Filter to connected only if enabled
    if (showConnectedOnly()) {
      all = all.filter(p => props.connectedProviderIds.has(p.id))
    }

    return all
  })

  // Auto-select first provider if none selected
  createMemo(() => {
    if (!selectedProviderId() && providers().length > 0) {
      setSelectedProviderId(providers()[0].id)
    }
  })

  // Get models for selected provider, filtered by search
  const models = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return []

    const allModels = getProviderModels(providerId)
    const query = searchQuery().toLowerCase().trim()

    if (!query) return allModels

    return allModels.filter(m =>
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      m.family?.toLowerCase().includes(query)
    )
  })

  const selectedProvider = createMemo(() => {
    const id = selectedProviderId()
    return providers().find(p => p.id === id)
  })

  const getModelCount = (provider: ModelsDevProvider) => {
    return Object.keys(provider.models || {}).length
  }

  const isProviderConnected = (providerId: string) => {
    return props.connectedProviderIds.has(providerId)
  }

  // Format price with color coding
  const getPriceColorClass = (cost: { input: number; output: number } | undefined) => {
    if (!cost) return "text-muted-foreground"
    const avgCost = (cost.input + cost.output) / 2
    if (avgCost === 0) return "text-success"
    if (avgCost < 1) return "text-success"
    if (avgCost < 10) return "text-warning"
    return "text-destructive"
  }

  const connectedCount = createMemo(() => {
    return getAllProviders().filter(p => props.connectedProviderIds.has(p.id)).length
  })

  return (
    <div class="flex flex-col gap-4 h-[520px] max-h-[520px]">
      {/* Header with search and filter */}
      <div class="flex items-center gap-4">
        <div class="flex-1 flex items-center gap-2 bg-secondary border border-border rounded-lg px-3 py-2 transition-colors focus-within:border-info">
          <Search class="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            class="flex-1 bg-transparent border-none outline-none text-[0.8125rem] text-foreground placeholder:text-muted-foreground"
            placeholder="Search providers or models..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
        </div>

        <button
          type="button"
          class={cn(
            "flex items-center gap-1.5 px-3 py-2 bg-secondary border border-border rounded-lg text-xs font-medium text-muted-foreground cursor-pointer transition-all whitespace-nowrap hover:bg-accent hover:border-border/80",
            showConnectedOnly() && "bg-info/10 border-info text-info"
          )}
          onClick={() => setShowConnectedOnly(!showConnectedOnly())}
          title={showConnectedOnly() ? "Showing connected providers only" : "Showing all providers"}
        >
          <Filter class="w-3.5 h-3.5" />
          <span>My Providers</span>
          <Show when={showConnectedOnly()}>
            <Badge variant="info" class="text-[0.625rem] px-1.5 py-0 min-w-5 text-center rounded-full">
              {connectedCount()}
            </Badge>
          </Show>
        </button>
      </div>

      {/* Main content: sidebar + list */}
      <div class="flex flex-1 min-h-0 border border-border rounded-lg overflow-hidden bg-background">
        {/* Provider sidebar */}
        <div class="w-[220px] shrink-0 flex flex-col bg-secondary border-r border-border">
          <div class="flex items-center justify-between px-4 py-3 border-b border-border">
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Providers</span>
            <span class="text-xs text-muted-foreground">{providers().length}</span>
          </div>

          <div class="flex-1 overflow-y-auto p-2">
            <For each={providers()}>
              {(provider) => {
                const isSelected = () => selectedProviderId() === provider.id
                const isConnected = () => isProviderConnected(provider.id)

                return (
                  <button
                    type="button"
                    class={cn(
                      "w-full flex items-center gap-2 px-2.5 py-2 bg-transparent border-none rounded-md cursor-pointer transition-colors text-left hover:bg-accent",
                      isSelected() && "bg-info/10",
                      isConnected() && "border-l-2 border-l-green-500 pl-[calc(0.625rem-2px)]"
                    )}
                    onClick={() => setSelectedProviderId(provider.id)}
                  >
                    <div class="w-6 h-6 flex items-center justify-center shrink-0">
                      <img
                        src={getProviderLogoUrl(provider.id)}
                        alt=""
                        class="w-full h-full object-contain rounded"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col">
                      <span class="text-[0.8125rem] font-medium text-foreground truncate">{provider.name}</span>
                      <span class="text-[0.6875rem] text-muted-foreground">{getModelCount(provider)} models</span>
                    </div>
                    <Show when={isConnected()}>
                      <span class="text-success shrink-0 animate-pulse" title="Connected">
                        <Zap class="w-3 h-3" />
                      </span>
                    </Show>
                    <Show when={isSelected()}>
                      <ChevronRight class="w-3.5 h-3.5 text-info" />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </div>

        {/* Model list */}
        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Show when={selectedProvider()}>
            <div class="flex items-center justify-between px-4 py-3.5 border-b border-border bg-background">
              <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                <img
                  src={getProviderLogoUrl(selectedProvider()!.id)}
                  alt=""
                  class="w-5 h-5 object-contain rounded"
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
                <span>{selectedProvider()!.name}</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-muted-foreground">{models().length} models</span>
                <Show
                  when={isProviderConnected(selectedProvider()!.id)}
                  fallback={
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 px-2.5 py-1 bg-secondary border border-border rounded-full text-[0.6875rem] font-medium text-muted-foreground cursor-pointer transition-all hover:bg-accent hover:border-info hover:text-info"
                      onClick={() => props.onConfigureProvider?.(selectedProvider()!.id)}
                      title="Configure this provider"
                    >
                      <Settings class="w-3 h-3" /> Configure
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 px-2.5 py-1 bg-success/10 border border-success/30 rounded-full text-[0.6875rem] font-medium text-success cursor-pointer transition-all hover:bg-success/20 hover:border-success/50"
                    onClick={() => props.onConfigureProvider?.(selectedProvider()!.id)}
                    title="Edit provider configuration"
                  >
                    <Zap class="w-3 h-3" /> Connected
                  </button>
                </Show>
              </div>
            </div>

            {/* Column headers */}
            <div class="grid grid-cols-[1fr_90px_90px_130px_110px] gap-4 px-4 py-2.5 bg-secondary border-b border-border text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
              <div>Model</div>
              <div>Context</div>
              <div>Output</div>
              <div>Price (per 1M)</div>
              <div>Capabilities</div>
            </div>

            {/* Model rows */}
            <div class="flex-1 overflow-y-auto p-2">
              <For each={models()}>
                {(model) => (
                  <button
                    type="button"
                    class="grid grid-cols-[1fr_90px_90px_130px_110px] gap-4 px-4 py-3 bg-transparent border-none rounded-md cursor-pointer transition-all text-left w-full items-center even:bg-secondary/30 hover:bg-info/[0.08] hover:shadow-[inset_3px_0_0_hsl(var(--info))]"
                    onClick={() => props.onSelectModel?.(selectedProviderId()!, model.id)}
                  >
                    <div class="min-w-0">
                      <div class="text-[0.8125rem] font-medium text-foreground truncate">{model.name}</div>
                      <div class="text-[0.6875rem] text-muted-foreground truncate font-mono">{model.id}</div>
                    </div>

                    <div class="text-xs font-medium text-muted-foreground font-mono">
                      <Show when={model.limit?.context} fallback="—">
                        {formatTokenCount(model.limit!.context)}
                      </Show>
                    </div>

                    <div class="text-xs font-medium text-muted-foreground font-mono">
                      <Show when={model.limit?.output} fallback="—">
                        {formatTokenCount(model.limit!.output)}
                      </Show>
                    </div>

                    <div class={cn("text-xs font-semibold font-mono", getPriceColorClass(model.cost))}>
                      <Show when={model.cost} fallback="—">
                        <span>${model.cost!.input}</span>
                        <span class="text-muted-foreground mx-0.5">/</span>
                        <span>${model.cost!.output}</span>
                      </Show>
                    </div>

                    <div class="flex items-center gap-1.5">
                      <Show when={model.reasoning}>
                        <span
                          class="flex items-center justify-center w-[1.375rem] h-[1.375rem] rounded bg-secondary border border-border text-muted-foreground transition-colors cursor-help hover:bg-accent hover:text-foreground"
                          title="Reasoning"
                          aria-label="Reasoning"
                        >
                          <Brain class="w-3 h-3" aria-hidden="true" />
                        </span>
                      </Show>
                      <Show when={model.tool_call}>
                        <span
                          class="flex items-center justify-center w-[1.375rem] h-[1.375rem] rounded bg-secondary border border-border text-muted-foreground transition-colors cursor-help hover:bg-accent hover:text-foreground"
                          title="Tools"
                          aria-label="Tools"
                        >
                          <Wrench class="w-3 h-3" aria-hidden="true" />
                        </span>
                      </Show>
                      <Show when={model.attachment}>
                        <span
                          class="flex items-center justify-center w-[1.375rem] h-[1.375rem] rounded bg-secondary border border-border text-muted-foreground transition-colors cursor-help hover:bg-accent hover:text-foreground"
                          title="Vision"
                          aria-label="Vision"
                        >
                          <Eye class="w-3 h-3" aria-hidden="true" />
                        </span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>

              <Show when={models().length === 0}>
                <div class="flex items-center justify-center h-full min-h-[200px] text-muted-foreground text-sm">
                  <Show when={searchQuery()}>
                    No models match "{searchQuery()}"
                  </Show>
                  <Show when={!searchQuery()}>
                    No models available
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={!selectedProvider()}>
            <div class="flex items-center justify-center h-full min-h-[200px] text-muted-foreground text-sm">
              Select a provider to view models
            </div>
          </Show>
        </div>
      </div>

      {/* Legend */}
      <div class="flex items-center justify-end gap-5 py-3 text-[0.6875rem] text-muted-foreground">
        <span class="flex items-center gap-1.5">
          <Brain class="w-3 h-3" /> Reasoning
        </span>
        <span class="flex items-center gap-1.5">
          <Wrench class="w-3 h-3" /> Tools
        </span>
        <span class="flex items-center gap-1.5">
          <Eye class="w-3 h-3" /> Vision
        </span>
        <Separator orientation="vertical" class="h-3" />
        <span class="flex items-center gap-1.5 text-success">Free</span>
        <span class="flex items-center gap-1.5 text-success">&lt;$1</span>
        <span class="flex items-center gap-1.5 text-warning">$1-10</span>
        <span class="flex items-center gap-1.5 text-destructive">&gt;$10</span>
      </div>
    </div>
  )
}

// Helper to format token counts
function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(0)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
  return n.toString()
}

export default ModelCatalogPanel
