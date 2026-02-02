import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Play,
  Search,
  Layers,
  GitBranch,
  Variable,
  ChevronRight,
  Filter,
  Clock,
  Tag,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("formula-browser")

// ============================================================================
// Types
// ============================================================================

interface FormulaVariable {
  name: string
  type: string
  description?: string
  default?: unknown
  required?: boolean
}

interface FormulaStep {
  id: string
  name: string
  action: string
  dependsOn?: string[]
  gate?: string
}

interface Formula {
  name: string
  description: string
  source: "built-in" | "global" | "project"
  variables: FormulaVariable[]
  steps: FormulaStep[]
  tags?: string[]
  parallelism?: number
  lastUsed?: string
}

interface FormulaBrowserProps {
  folder?: string
  compact?: boolean
  onInstantiate?: (formulaName: string, variables: Record<string, unknown>) => void
}

// ============================================================================
// Constants
// ============================================================================

const SOURCE_CONFIG = {
  "built-in": { label: "Built-in", color: "bg-muted text-muted-foreground" },
  global: { label: "Global", color: "bg-primary/10 text-primary" },
  project: { label: "Project", color: "bg-success/10 text-success" },
} as const

// ============================================================================
// Component
// ============================================================================

const FormulaBrowser: Component<FormulaBrowserProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("")
  const [sourceFilter, setSourceFilter] = createSignal<string | null>(null)
  const [selectedFormula, setSelectedFormula] = createSignal<string | null>(null)
  const [variableValues, setVariableValues] = createSignal<Record<string, string>>({})

  const fetchFormulas = async (folder: string | undefined): Promise<Formula[]> => {
    try {
      const params = new URLSearchParams()
      if (folder) params.set("folder", folder)
      const resp = await fetch(`/api/era/formulas?${params}`)
      if (!resp.ok) return []
      const data = await resp.json()
      return data.formulas ?? []
    } catch (err) {
      log.error("Failed to fetch formulas:", err)
      return []
    }
  }

  const [formulas, { refetch }] = createResource(() => props.folder, fetchFormulas)

  const filtered = createMemo(() => {
    let result = formulas() ?? []
    const q = searchQuery().toLowerCase()
    if (q) {
      result = result.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q) ||
          f.tags?.some((t) => t.toLowerCase().includes(q))
      )
    }
    const src = sourceFilter()
    if (src) {
      result = result.filter((f) => f.source === src)
    }
    return result
  })

  const selected = createMemo(() => {
    const name = selectedFormula()
    if (!name) return null
    return (formulas() ?? []).find((f) => f.name === name) ?? null
  })

  const handleInstantiate = () => {
    const formula = selected()
    if (!formula || !props.onInstantiate) return
    const vars: Record<string, unknown> = {}
    for (const v of formula.variables) {
      const val = variableValues()[v.name]
      if (val !== undefined && val !== "") {
        vars[v.name] = v.type === "number" ? Number(val) : v.type === "boolean" ? val === "true" : val
      } else if (v.default !== undefined) {
        vars[v.name] = v.default
      }
    }
    props.onInstantiate(formula.name, vars)
    log.info("Instantiated formula:", formula.name, vars)
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <Layers class="h-4 w-4 text-primary" />
          Workflow Formulas
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <Search class="h-3.5 w-3.5" />
        </Button>
      </CardHeader>

      <CardContent class="flex flex-col gap-3 pt-0">
        {/* Search + Filter */}
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search formulas..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Button
            variant={sourceFilter() ? "default" : "outline"}
            size="sm"
            class="h-8 px-2"
            onClick={() => {
              const sources = [null, "built-in", "global", "project"]
              const cur = sources.indexOf(sourceFilter())
              setSourceFilter(sources[(cur + 1) % sources.length])
            }}
          >
            <Filter class="h-3.5 w-3.5" />
          </Button>
        </div>

        <Show when={sourceFilter()}>
          <Badge class={cn("w-fit text-xs", SOURCE_CONFIG[sourceFilter() as keyof typeof SOURCE_CONFIG]?.color)}>
            {SOURCE_CONFIG[sourceFilter() as keyof typeof SOURCE_CONFIG]?.label}
          </Badge>
        </Show>

        <Separator />

        {/* Formula List */}
        <Show
          when={!formulas.loading}
          fallback={<p class="text-xs text-muted-foreground">Loading formulas...</p>}
        >
          <Show
            when={(filtered().length > 0)}
            fallback={<p class="text-xs text-muted-foreground">No formulas found.</p>}
          >
            <div class="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
              <For each={filtered()}>
                {(formula) => (
                  <button
                    class={cn(
                      "flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors",
                      selectedFormula() === formula.name
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    )}
                    onClick={() => {
                      setSelectedFormula(formula.name)
                      setVariableValues({})
                    }}
                  >
                    <Layers class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-medium truncate">{formula.name}</span>
                        <Badge class={cn("text-[10px] px-1.5 py-0", SOURCE_CONFIG[formula.source]?.color)}>
                          {formula.source}
                        </Badge>
                      </div>
                      <p class="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                        {formula.description}
                      </p>
                      <div class="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span class="flex items-center gap-1">
                          <Variable class="h-3 w-3" />
                          {formula.variables.length} vars
                        </span>
                        <span class="flex items-center gap-1">
                          <GitBranch class="h-3 w-3" />
                          {formula.steps.length} steps
                        </span>
                        <Show when={formula.tags && formula.tags.length > 0}>
                          <span class="flex items-center gap-1">
                            <Tag class="h-3 w-3" />
                            {formula.tags!.join(", ")}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <ChevronRight class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>

        {/* Formula Detail / Instantiation */}
        <Show when={selected()}>
          {(_data) => {
            const formula = selected()!
            return (
              <div class="flex flex-col gap-2 rounded-md border border-primary/20 bg-primary/5 p-3">
                <h4 class="text-xs font-semibold">{formula.name}</h4>

                {/* Dependency Graph Preview */}
                <div class="flex flex-col gap-1">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Steps</span>
                  <For each={formula.steps}>
                    {(step, idx) => (
                      <div class="flex items-center gap-2 text-xs">
                        <span class={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium",
                          step.gate ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground"
                        )}>
                          {idx() + 1}
                        </span>
                        <span class="flex-1">{step.name}</span>
                        <Show when={step.gate}>
                          <Badge class="text-[10px] bg-warning/10 text-warning px-1.5 py-0">
                            {step.gate}
                          </Badge>
                        </Show>
                        <Show when={step.dependsOn && step.dependsOn.length > 0}>
                          <span class="text-[10px] text-muted-foreground">
                            ← {step.dependsOn!.join(", ")}
                          </span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                {/* Variable Form */}
                <Show when={formula.variables.length > 0}>
                  <Separator />
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Variables</span>
                  <div class="flex flex-col gap-1.5">
                    <For each={formula.variables}>
                      {(variable) => (
                        <div class="flex flex-col gap-0.5">
                          <label class="flex items-center gap-1 text-[11px] text-foreground">
                            {variable.name}
                            <Show when={variable.required !== false}>
                              <span class="text-destructive">*</span>
                            </Show>
                          </label>
                          <input
                            type={variable.type === "number" ? "number" : "text"}
                            placeholder={variable.default !== undefined ? String(variable.default) : variable.description ?? ""}
                            value={variableValues()[variable.name] ?? ""}
                            onInput={(e) => {
                              setVariableValues((prev) => ({
                                ...prev,
                                [variable.name]: e.currentTarget.value,
                              }))
                            }}
                            class="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Instantiate Button */}
                <Button
                  size="sm"
                  class="mt-1"
                  onClick={handleInstantiate}
                  disabled={!props.onInstantiate}
                >
                  <Play class="mr-1 h-3.5 w-3.5" />
                  Instantiate
                </Button>
              </div>
            )
          }}
        </Show>
      </CardContent>
    </Card>
  )
}

export default FormulaBrowser
