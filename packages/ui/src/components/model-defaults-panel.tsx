import { Combobox } from "@kobalte/core/combobox"
import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { ChevronDown } from "lucide-solid"
import { useConfig, type ModelPreference } from "../stores/preferences"
import { instances } from "../stores/instances"
import { providers, agents, fetchProviders, fetchAgents } from "../stores/sessions"
import type { Model } from "../types/session"

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

  const customFilter = (option: FlatModel, inputValue: string) => {
    return option.searchText.toLowerCase().includes(inputValue.toLowerCase())
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">Model Defaults (Per Agent)</h3>
        <p class="panel-subtitle">Applied when sessions prompt using that agent</p>
      </div>

      <div class="panel-body" style={{ gap: "var(--space-md)" }}>
        <div class="flex items-end flex-wrap" style={{ gap: "var(--space-sm)" }}>
          <div class="flex flex-col" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Reference Instance</label>
            <select
              class="modal-input min-w-[200px]"
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

          <div class="flex flex-col" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Agent</label>
            <input
              class="modal-input min-w-[180px]"
              value={newAgentName()}
              onInput={(event) => setNewAgentName(event.currentTarget.value)}
              list="agent-name-suggestions"
              placeholder="e.g. plan"
            />
            <datalist id="agent-name-suggestions">
              <For each={availableAgents()}>{(name) => <option value={name} />}</For>
            </datalist>
          </div>

          <div class="flex flex-col flex-1 min-w-[280px]" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Model</label>
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
              itemComponent={(itemProps) => (
                <Combobox.Item item={itemProps.item} class="selector-option">
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
                </Combobox.Item>
              )}
            >
              <Combobox.Control class="relative w-full">
                <Combobox.Input class="modal-input" />
                <Combobox.Trigger class="selector-trigger" aria-label="Choose model">
                  <Combobox.Icon class="selector-trigger-icon">
                    <ChevronDown class="w-3 h-3" />
                  </Combobox.Icon>
                </Combobox.Trigger>
              </Combobox.Control>
              <Combobox.Portal>
                <Combobox.Content class="selector-popover">
                  <Combobox.Listbox class="selector-listbox" />
                </Combobox.Content>
              </Combobox.Portal>
            </Combobox>
          </div>

          <button type="button" class="modal-button modal-button--primary" onClick={addDefault}>
            Add
          </button>
        </div>

        <Show
          when={Object.keys(defaults()).length > 0}
          fallback={<p class="text-xs text-secondary italic">No per-agent defaults configured yet.</p>}
        >
          <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
            <For each={Object.entries(defaults()).sort(([a], [b]) => a.localeCompare(b))}>
              {([agentName, model]) => (
                <div class="px-3 py-2 rounded-md border bg-surface-secondary border-base flex items-center justify-between" style={{ gap: "var(--space-sm)" }}>
                  <div class="flex flex-col min-w-0">
                    <div class="text-sm text-primary font-medium truncate">{agentName}</div>
                    <div class="text-xs text-secondary truncate">
                      {model.providerId}/{model.modelId}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="modal-button modal-button--danger"
                    onClick={() => removeDefault(agentName)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default ModelDefaultsPanel
