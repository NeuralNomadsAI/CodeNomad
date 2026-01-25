import { Combobox } from "@kobalte/core/combobox"
import { createEffect, createMemo } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import { getLogger } from "../lib/logger"
import { getModelThinkingSelection, setModelThinkingSelection } from "../stores/preferences"
import Kbd from "./kbd"

const log = getLogger("session")

interface ThinkingSelectorProps {
  instanceId: string
  currentModel: { providerId: string; modelId: string }
}

type ThinkingOption = {
  key: string
  label: string
  value: string | undefined
}

export default function ThinkingSelector(props: ThinkingSelectorProps) {
  const instanceProviders = () => providers().get(props.instanceId) || []

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch((error) => log.error("Failed to fetch providers", error))
    }
  })

  const variantKeys = createMemo(() => {
    const { providerId, modelId } = props.currentModel
    const provider = instanceProviders().find((p) => p.id === providerId)
    const model = provider?.models.find((m) => m.id === modelId)
    return model?.variantKeys ?? []
  })

  const options = createMemo<ThinkingOption[]>(() => {
    const keys = variantKeys()
    return [{ key: "__default__", label: "Default", value: undefined }, ...keys.map((k) => ({ key: k, label: k, value: k }))]
  })

  const currentValue = createMemo(() => {
    const selected = getModelThinkingSelection(props.currentModel)
    const keys = variantKeys()
    if (selected && keys.includes(selected)) {
      return options().find((opt) => opt.value === selected)
    }
    return options()[0]
  })

  const handleChange = (value: ThinkingOption | null) => {
    if (!value) return
    setModelThinkingSelection(props.currentModel, value.value)
  }

  const triggerPrimary = createMemo(() => {
    const selected = currentValue()?.value
    return selected ? `Thinking: ${selected}` : "Thinking: Default"
  })

  return (
    <div class="sidebar-selector">
      <Combobox<ThinkingOption>
        value={currentValue()}
        onChange={handleChange}
        options={options()}
        optionValue="key"
        optionLabel="label"
        placeholder="Thinking: Default"
        itemComponent={(itemProps) => (
          <Combobox.Item item={itemProps.item} class="selector-option">
            <div class="selector-option-content">
              <Combobox.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Combobox.ItemLabel>
            </div>
            <Combobox.ItemIndicator class="selector-option-indicator">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </Combobox.ItemIndicator>
          </Combobox.Item>
        )}
      >
        <Combobox.Control class="relative w-full" data-thinking-selector-control>
          <Combobox.Input class="sr-only" data-thinking-selector />
          <Combobox.Trigger class="selector-trigger">
            <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
              <span class="selector-trigger-primary selector-trigger-primary--align-left">{triggerPrimary()}</span>
            </div>
            <span class="selector-trigger-hint" aria-hidden="true">
              <Kbd shortcut="cmd+shift+t" />
            </span>
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
  )
}
