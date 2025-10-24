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
            class="px-3 py-2 cursor-pointer hover:bg-blue-50 rounded outline-none data-[highlighted]:bg-blue-100 flex items-start gap-2"
          >
            <div class="flex flex-col flex-1 min-w-0">
              <Combobox.ItemLabel class="font-medium text-sm text-gray-900">
                {itemProps.item.rawValue.name}
              </Combobox.ItemLabel>
              <Combobox.ItemDescription class="text-xs text-gray-600">
                {itemProps.item.rawValue.providerName} • {itemProps.item.rawValue.providerId}/
                {itemProps.item.rawValue.id}
              </Combobox.ItemDescription>
            </div>
            <Combobox.ItemIndicator class="flex-shrink-0 mt-0.5">
              <svg class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
            class="inline-flex items-center justify-between gap-2 px-2 py-1 bg-white border border-gray-300 rounded hover:bg-gray-50 outline-none focus:ring-2 focus:ring-blue-500 text-xs min-w-[180px]"
          >
            <div class="flex flex-col items-start min-w-0">
              <span class="text-gray-700 font-medium">Model: {currentModelValue()?.name ?? "None"}</span>
              {currentModelValue() && (
                <span class="text-gray-500 text-[10px]">
                  {currentModelValue()!.providerId}/{currentModelValue()!.id}
                </span>
              )}
            </div>
            <Combobox.Icon class="flex-shrink-0">
              <ChevronDown class="w-3 h-3 text-gray-500" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content class="bg-white border border-gray-300 rounded-md shadow-lg overflow-hidden z-50 min-w-[300px]">
            <div class="p-2 border-b border-gray-200">
              <Combobox.Input
                ref={searchInputRef}
                class="w-full px-3 py-1.5 text-xs border border-gray-300 rounded outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Search models..."
              />
            </div>
            <Combobox.Listbox class="max-h-64 overflow-auto p-1" />
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <span class="text-xs text-gray-400">
        <Kbd shortcut="cmd+shift+m" />
      </span>
    </div>
  )
}
