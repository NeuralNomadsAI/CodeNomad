import { Combobox } from "@kobalte/core/combobox"
import { createEffect, createMemo, createSignal } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import type { Model } from "../types/session"
import Kbd from "./kbd"

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

export default function ModelSelector(props: ModelSelectorProps) {
  const instanceProviders = () => providers().get(props.instanceId) || []
  const [isOpen, setIsOpen] = createSignal(false)
  let triggerRef!: HTMLButtonElement
  let searchInputRef!: HTMLInputElement

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch(console.error)
    }
  })

  const allModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        providerName: p.name,
        key: `${m.providerId}/${m.id}`,
        searchText: `${m.name} ${p.name} ${m.providerId} ${m.id} ${m.providerId}/${m.id}`,
      })),
    ),
  )

  const currentModelValue = createMemo(() =>
    allModels().find((m) => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId),
  )

  const handleChange = async (value: FlatModel | null) => {
    if (!value) return
    await props.onModelChange({ providerId: value.providerId, modelId: value.id })
  }

  const customFilter = (option: FlatModel, inputValue: string) => {
    return option.searchText.toLowerCase().includes(inputValue.toLowerCase())
  }

  createEffect(() => {
    if (isOpen()) {
      setTimeout(() => {
        searchInputRef?.focus()
      }, 100)
    }
  })

  return (
    <div class="flex items-center gap-2">
      <Combobox<FlatModel>
        value={currentModelValue()}
        onChange={handleChange}
        onOpenChange={setIsOpen}
        options={allModels()}
        optionValue="key"
        optionTextValue="searchText"
        optionLabel="name"
        placeholder="Search models..."
        defaultFilter={customFilter}
        allowsEmptyCollection
        itemComponent={(itemProps) => (
          <Combobox.Item
            item={itemProps.item}
            class="selector-option"
          >
            <div class="selector-option-content">
              <Combobox.ItemLabel class="selector-option-label">
                {itemProps.item.rawValue.name}
              </Combobox.ItemLabel>
              <Combobox.ItemDescription class="selector-option-description">
                {itemProps.item.rawValue.providerName} • {itemProps.item.rawValue.providerId}/
                {itemProps.item.rawValue.id}
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
        <Combobox.Control class="relative" data-model-selector-control>
          <Combobox.Input class="sr-only" data-model-selector />
          <Combobox.Trigger
            ref={triggerRef}
            class="selector-trigger"
          >
            <div class="selector-trigger-label">
              <span class="selector-trigger-primary">
                Model: {currentModelValue()?.name ?? "None"}
              </span>
              {currentModelValue() && (
                <span class="selector-trigger-secondary">
                  {currentModelValue()!.providerId}/{currentModelValue()!.id}
                </span>
              )}
            </div>
            <Combobox.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content class="selector-popover">
            <div class="selector-search-container">
              <Combobox.Input
                ref={searchInputRef}
                class="selector-search-input"
                placeholder="Search models..."
              />
            </div>
            <Combobox.Listbox class="selector-listbox" />
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <span class="hint">
        <Kbd shortcut="cmd+shift+m" />
      </span>
    </div>
  )
}
