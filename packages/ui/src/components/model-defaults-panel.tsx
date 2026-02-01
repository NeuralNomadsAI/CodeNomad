import { Combobox } from "@kobalte/core/combobox"
import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { ChevronDown } from "lucide-solid"
import { useConfig, type ModelPreference } from "../stores/preferences"
import { instances } from "../stores/instances"
import { providers, agents, fetchProviders, fetchAgents } from "../stores/sessions"
import type { Model } from "../types/session"
import { cn } from "../lib/cn"
import { Badge, Button, Card, Input, Separator } from "./ui"

interface FlatModel extends Model {
  providerName: string
  key: string
  searchText: string
}

const ModelDefaultsPanel: Component = () => {
  const { preferences, updatePreferences } = useConfig()

  const instanceOptions = createMemo(() => Array.from(instances().values()).filter((i) => i.status === "ready" && i.client))
  const [referenceInstanceId, setReferenceInstanceId] = createSignal<string | null>(null)

  createEffect(() => {
    if (!referenceInstanceId() && instanceOptions().length > 0) {
      setReferenceInstanceId(instanceOptions()[0].id)
    }
  })

  createEffect(() => {
    const instanceId = referenceInstanceId()
    if (!instanceId) return
    if ((providers().get(instanceId) ?? []).length === 0) {
      fetchProviders(instanceId).catch(() => {})
    }
    if ((agents().get(instanceId) ?? []).length === 0) {
      fetchAgents(instanceId).catch(() => {})
    }
  })

  const availableAgents = createMemo(() => {
    const instanceId = referenceInstanceId()
    if (!instanceId) return []
    const list = agents().get(instanceId) ?? []
    return list.map((a) => a.name).filter(Boolean).sort((a, b) => a.localeCompare(b))
  })

  const allModels = createMemo<FlatModel[]>(() => {
    const instanceId = referenceInstanceId()
    if (!instanceId) return []
    const instanceProviders = providers().get(instanceId) ?? []
    return instanceProviders
      .flatMap((p) =>
        p.models.map((m) => ({
          ...m,
          providerName: p.name,
          key: `${m.providerId}/${m.id}`,
          searchText: `${m.name} ${p.name} ${m.providerId} ${m.id} ${m.providerId}/${m.id}`,
        })),
      )
      .sort((a, b) => `${a.providerId}/${a.id}`.localeCompare(`${b.providerId}/${b.id}`))
  })

  const [newAgentName, setNewAgentName] = createSignal("")
  const [selectedModel, setSelectedModel] = createSignal<FlatModel | null>(null)

  const defaults = createMemo(() => preferences().modelDefaultsByAgent ?? {})

  const saveDefault = (agentName: string, model: ModelPreference) => {
    const next = { ...(preferences().modelDefaultsByAgent ?? {}) }
    next[agentName] = model
    updatePreferences({ modelDefaultsByAgent: next })
  }

  const removeDefault = (agentName: string) => {
    const next = { ...(preferences().modelDefaultsByAgent ?? {}) }
    delete next[agentName]
    updatePreferences({ modelDefaultsByAgent: next })
  }

  const addDefault = () => {
    const agentName = newAgentName().trim()
    const model = selectedModel()
    if (!agentName || !model) return
    saveDefault(agentName, { providerId: model.providerId, modelId: model.id })
    setNewAgentName("")
    setSelectedModel(null)
  }

  const customFilter = (option: FlatModel | undefined, inputValue: string) => {
    if (!option?.searchText) return false
    return option.searchText.toLowerCase().includes(inputValue.toLowerCase())
  }

  return (
    <Card>
      <div class="px-4 py-3 border-b border-border bg-secondary">
        <h3 class="text-base font-semibold text-foreground">Model Defaults (Per Agent)</h3>
        <p class="text-xs mt-0.5 text-muted-foreground">Applied when sessions prompt using that agent</p>
      </div>

      <div class="p-4 bg-background flex flex-col gap-4">
        <div class="flex items-end flex-wrap gap-3">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-muted-foreground">Reference Instance</label>
            <select
              class={cn(
                "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "min-w-[200px]"
              )}
              value={referenceInstanceId() ?? ""}
              onChange={(event) => setReferenceInstanceId(event.currentTarget.value)}
            >
              <For each={instanceOptions()}>
                {(instance) => (
                  <option value={instance.id}>
                    {instance.binaryLabel ?? "opencode"} • {instance.folder}
                  </option>
                )}
              </For>
            </select>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-muted-foreground">Agent</label>
            <Input
              class="min-w-[180px]"
              value={newAgentName()}
              onInput={(event) => setNewAgentName(event.currentTarget.value)}
              list="agent-name-suggestions"
              placeholder="e.g. plan"
            />
            <datalist id="agent-name-suggestions">
              <For each={availableAgents()}>{(name) => <option value={name} />}</For>
            </datalist>
          </div>

          <div class="flex flex-col flex-1 min-w-[280px] gap-1.5">
            <label class="text-xs text-muted-foreground">Model</label>
            <Combobox<FlatModel>
              value={selectedModel()}
              onChange={(value) => setSelectedModel(value)}
              options={allModels()}
              optionValue="key"
              optionTextValue="searchText"
              optionLabel="name"
              placeholder="Search models..."
              defaultFilter={customFilter}
              allowsEmptyCollection
              itemComponent={(itemProps) => {
                const model = itemProps.item.rawValue as FlatModel | undefined
                return (
                  <Combobox.Item item={itemProps.item} class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent transition-colors">
                    <div class="flex flex-col flex-1 min-w-0">
                      <Combobox.ItemLabel class="text-sm font-medium text-foreground truncate">{model?.name ?? "Unknown"}</Combobox.ItemLabel>
                      <Combobox.ItemDescription class="text-xs text-muted-foreground truncate">
                        {model?.providerName ?? "?"} • {model?.providerId ?? "?"}/{model?.id ?? "?"}
                      </Combobox.ItemDescription>
                    </div>
                    <Combobox.ItemIndicator class="w-4 h-4 text-primary">
                      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )
              }}
            >
              <Combobox.Control class="relative w-full">
                <Combobox.Input
                  class={cn(
                    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
                    "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  )}
                />
                <Combobox.Trigger class="flex items-center justify-between w-full px-3 py-2 text-sm border border-border rounded-md bg-background hover:bg-accent transition-colors cursor-pointer" aria-label="Choose model">
                  <Combobox.Icon class="w-4 h-4 text-muted-foreground">
                    <ChevronDown class="w-3 h-3" />
                  </Combobox.Icon>
                </Combobox.Trigger>
              </Combobox.Control>
              <Combobox.Portal>
                <Combobox.Content class="w-full min-w-[200px] bg-popover border border-border rounded-md shadow-md overflow-hidden">
                  <Combobox.Listbox class="max-h-60 overflow-y-auto py-1" />
                </Combobox.Content>
              </Combobox.Portal>
            </Combobox>
          </div>

          <Button onClick={addDefault}>
            Add
          </Button>
        </div>

        <Show
          when={Object.keys(defaults()).length > 0}
          fallback={<p class="text-xs text-muted-foreground italic">No per-agent defaults configured yet.</p>}
        >
          <div class="flex flex-col gap-3">
            <For each={Object.entries(defaults()).sort(([a], [b]) => a.localeCompare(b))}>
              {([agentName, model]) => (
                <div class="px-3 py-2 rounded-md border border-border bg-secondary flex items-center justify-between gap-3">
                  <div class="flex flex-col min-w-0">
                    <div class="text-sm text-foreground font-medium truncate">{agentName}</div>
                    <div class="text-xs text-muted-foreground truncate">
                      {model.providerId}/{model.modelId}
                    </div>
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => removeDefault(agentName)}>
                    Remove
                  </Button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Card>
  )
}

export default ModelDefaultsPanel
