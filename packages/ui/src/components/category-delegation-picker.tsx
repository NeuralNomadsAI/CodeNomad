import { Component, For, Show, createSignal, createResource } from "solid-js"
import {
  Brain,
  Zap,
  Paintbrush,
  FileText,
  Cpu,
  ArrowRight,
  RefreshCw,
  Settings2,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Badge, Card, CardContent, CardHeader, CardTitle, Button, Tooltip } from "./ui"

const log = getLogger("category-delegation-picker")

interface DelegationCategory {
  id: string
  name: string
  model: string
  keywords: string[]
  active: boolean
}

interface CategoryDelegationPickerProps {
  folder?: string
  currentPrompt?: string
  onCategorySelect?: (categoryId: string) => void
}

const CATEGORY_ICONS: Record<string, Component<{ class?: string }>> = {
  "visual-engineering": (props) => <Paintbrush class={props.class} />,
  ultrabrain: (props) => <Brain class={props.class} />,
  artistry: (props) => <Paintbrush class={props.class} />,
  quick: (props) => <Zap class={props.class} />,
  writing: (props) => <FileText class={props.class} />,
  "unspecified-low": (props) => <Cpu class={props.class} />,
  "unspecified-high": (props) => <Cpu class={props.class} />,
}

const CATEGORY_COLORS: Record<string, string> = {
  "visual-engineering": "bg-info/10 text-info border-info/20",
  ultrabrain: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  artistry: "bg-pink-500/10 text-pink-500 border-pink-500/20",
  quick: "bg-success/10 text-success border-success/20",
  writing: "bg-warning/10 text-warning border-warning/20",
  "unspecified-low": "bg-muted text-muted-foreground border-border",
  "unspecified-high": "bg-secondary text-secondary-foreground border-border",
}

function detectCategory(prompt: string, categories: DelegationCategory[]): string | null {
  if (!prompt.trim()) return null
  const lower = prompt.toLowerCase()
  for (const cat of categories) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      return cat.id
    }
  }
  return null
}

const CategoryDelegationPicker: Component<CategoryDelegationPickerProps> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  const [categories, { refetch }] = createResource<DelegationCategory[]>(async () => {
    try {
      const params = props.folder ? `?folder=${encodeURIComponent(props.folder)}` : ""
      const res = await fetch(`/api/era/delegation/categories${params}`)
      if (!res.ok) return []
      const data = await res.json()
      return data.categories ?? []
    } catch (err) {
      log.error("Failed to fetch categories", err)
      return []
    }
  })

  const detectedCategory = () => {
    const cats = categories()
    if (!cats || !props.currentPrompt) return null
    return detectCategory(props.currentPrompt, cats)
  }

  const handleSelect = (id: string) => {
    setSelectedId(id)
    props.onCategorySelect?.(id)
  }

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <CardTitle class="text-sm font-medium">Agent Delegation</CardTitle>
          <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh categories">
            <RefreshCw class="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-2">
        <Show when={categories.loading}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Loading categories...
          </div>
        </Show>

        <Show when={!categories.loading && categories()}>
          <div class="flex flex-wrap gap-1.5">
            <For each={categories()}>
              {(cat) => {
                const isDetected = () => detectedCategory() === cat.id
                const isSelected = () => selectedId() === cat.id
                const IconComponent = CATEGORY_ICONS[cat.id] ?? ((p: { class?: string }) => <Cpu class={p.class} />)
                const colorClass = CATEGORY_COLORS[cat.id] ?? "bg-muted text-muted-foreground border-border"

                return (
                  <button
                    class={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all",
                      colorClass,
                      isDetected() && "ring-2 ring-primary/40",
                      isSelected() && "ring-2 ring-primary",
                      "hover:opacity-80 cursor-pointer"
                    )}
                    onClick={() => handleSelect(cat.id)}
                    title={`${cat.name} — ${cat.model}`}
                  >
                    <IconComponent class="h-3 w-3" />
                    {cat.name}
                    <Show when={isDetected()}>
                      <ArrowRight class="h-2.5 w-2.5 animate-bounce-in" />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>

          <Show when={detectedCategory()}>
            {(catId) => {
              const cat = () => categories()?.find((c) => c.id === catId())
              return (
                <Show when={cat()}>
                  {(c) => (
                    <div class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Settings2 class="h-3 w-3" />
                      Auto-detected: <span class="font-medium text-foreground">{c().name}</span>
                      <ArrowRight class="h-3 w-3" />
                      <Badge variant="outline" class="text-[10px] px-1.5 py-0">
                        {c().model}
                      </Badge>
                    </div>
                  )}
                </Show>
              )
            }}
          </Show>
        </Show>

        <Show when={!categories.loading && (!categories() || categories()!.length === 0)}>
          <p class="text-xs text-muted-foreground">No delegation categories configured.</p>
        </Show>
      </CardContent>
    </Card>
  )
}

export default CategoryDelegationPicker
