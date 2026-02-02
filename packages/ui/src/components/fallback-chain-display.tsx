import { Component, For, Show, createResource } from "solid-js"
import { ArrowRight, Check, X, RefreshCw, Layers } from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "./ui"

const log = getLogger("fallback-chain-display")

interface ModelNode {
  id: string
  name: string
  available: boolean
}

interface FallbackChain {
  provider: string
  primary: ModelNode
  fallbacks: ModelNode[]
}

interface FallbackChainDisplayProps {
  compact?: boolean
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "text-orange-500",
  openai: "text-green-500",
  google: "text-blue-500",
}

const FallbackChainDisplay: Component<FallbackChainDisplayProps> = (props) => {
  const [chains, { refetch }] = createResource<FallbackChain[]>(async () => {
    try {
      const res = await fetch("/api/era/models/fallback-chain")
      if (!res.ok) return []
      const data = await res.json()
      return data.chains ?? []
    } catch (err) {
      log.error("Failed to fetch fallback chains", err)
      return []
    }
  })

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Layers class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">Model Fallback Chains</CardTitle>
          </div>
          <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh fallback chains">
            <RefreshCw class="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        <Show when={chains.loading}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Loading chains...
          </div>
        </Show>

        <Show when={!chains.loading && chains()}>
          <For each={chains()}>
            {(chain) => (
              <div class="space-y-1.5">
                <div class={cn("text-xs font-medium capitalize", PROVIDER_COLORS[chain.provider] ?? "text-foreground")}>
                  {chain.provider}
                </div>
                <div class="flex items-center flex-wrap gap-1">
                  <ModelChip model={chain.primary} isPrimary />
                  <For each={chain.fallbacks}>
                    {(fb) => (
                      <>
                        <ArrowRight class="h-3 w-3 text-muted-foreground shrink-0" />
                        <ModelChip model={fb} />
                      </>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>

        <Show when={!chains.loading && (!chains() || chains()!.length === 0)}>
          <p class="text-xs text-muted-foreground">No model chains configured.</p>
        </Show>
      </CardContent>
    </Card>
  )
}

const ModelChip: Component<{ model: ModelNode; isPrimary?: boolean }> = (props) => {
  return (
    <div
      class={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
        props.model.available
          ? "border-border bg-background text-foreground"
          : "border-destructive/30 bg-destructive/5 text-destructive line-through",
        props.isPrimary && "font-medium border-primary/30 bg-primary/5"
      )}
    >
      {props.model.available ? (
        <Check class="h-2.5 w-2.5 text-success" />
      ) : (
        <X class="h-2.5 w-2.5 text-destructive" />
      )}
      {props.model.name}
      <Show when={props.isPrimary}>
        <Badge variant="outline" class="text-[9px] px-1 py-0 ml-0.5">
          primary
        </Badge>
      </Show>
    </div>
  )
}

export default FallbackChainDisplay
