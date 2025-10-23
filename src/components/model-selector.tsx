import { Combobox } from "@kobalte/core/combobox"
import { For, Show, createEffect, createMemo } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import type { Provider, Model } from "../types/session"

interface ModelSelectorProps {
  instanceId: string
  sessionId: string
  currentModel: { providerId: string; modelId: string }
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

interface FlatModel extends Model {
  providerName: string
}

export default function ModelSelector(props: ModelSelectorProps) {
  const instanceProviders = () => providers().get(props.instanceId) || []
  let listboxRef!: HTMLUListElement
  let inputRef!: HTMLInputElement

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch(console.error)
    }
  })

  const handleFocus = (e: FocusEvent) => {
    const input = e.target as HTMLInputElement
    input.select()
  }

  const allModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        providerName: p.name,
      })),
    ),
  )

  const currentModelValue = createMemo(() =>
    allModels().find((m) => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId),
  )

  const handleChange = async (value: FlatModel | null) => {
    if (!value) return

    if (value.providerId !== props.currentModel.providerId || value.id !== props.currentModel.modelId) {
      await props.onModelChange({ providerId: value.providerId, modelId: value.id })
    }
  }

  return (
    <Combobox
      value={currentModelValue()}
      onChange={handleChange}
      options={allModels()}
      optionValue={(m) => `${m.providerId}/${m.id}`}
      optionTextValue={(m) => `${m.name} ${m.providerName} ${m.providerId}/${m.id}`}
      optionLabel="name"
      placeholder="Search models..."
      defaultFilter="contains"
      triggerMode="focus"
      allowsEmptyCollection={false}
      itemComponent={(itemProps) => (
        <Combobox.Item
          item={itemProps.item}
          class="px-3 py-2 cursor-pointer hover:bg-gray-100 rounded outline-none focus:bg-gray-100 flex items-start gap-2"
        >
          <div class="flex flex-col flex-1 min-w-0">
            <Combobox.ItemLabel class="font-medium text-sm text-gray-900">
              {itemProps.item.rawValue.name}
            </Combobox.ItemLabel>
            <Combobox.ItemDescription class="text-xs text-gray-600">
              {itemProps.item.rawValue.providerName} • {itemProps.item.rawValue.providerId}/{itemProps.item.rawValue.id}
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
      <Combobox.Control class="inline-flex items-center justify-between gap-1 px-2 py-1 bg-white border border-gray-300 rounded hover:bg-gray-50 outline-none focus-within:ring-2 focus-within:ring-blue-500 text-xs min-w-[140px]">
        <Combobox.Input
          ref={inputRef}
          onFocus={handleFocus}
          class="bg-transparent border-none outline-none text-xs text-gray-700 placeholder:text-gray-500 w-full min-w-0 px-0"
        />
        <Combobox.Trigger class="flex items-center justify-center">
          <Combobox.Icon>
            <ChevronDown class="w-3 h-3 text-gray-500" />
          </Combobox.Icon>
        </Combobox.Trigger>
      </Combobox.Control>

      <Combobox.Portal>
        <Combobox.Content class="bg-white border border-gray-300 rounded-md shadow-lg max-h-80 overflow-hidden p-1 z-50 min-w-[300px]">
          <Combobox.Listbox ref={listboxRef} scrollRef={() => listboxRef} class="max-h-80 overflow-auto" />
        </Combobox.Content>
      </Combobox.Portal>
    </Combobox>
  )
}
