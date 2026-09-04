import { Select } from "@kobalte/core/select"
import { ChevronDown } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, type Accessor, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import type { BehaviorSetting } from "../../lib/settings/behavior-registry"
import type { Preferences } from "../../stores/preferences"

type SelectOption = { value: string; label: string }

interface BehaviorSettingRowsProps {
  settings: Accessor<BehaviorSetting[]>
  preferences: Accessor<Preferences>
}

export const BehaviorSettingRows: Component<BehaviorSettingRowsProps> = (props) => {
  const { t } = useI18n()
  const [overrides, setOverrides] = createSignal<Map<string, unknown>>(new Map())

  const setOverride = (id: string, value: unknown) => {
    setOverrides((previous) => {
      const next = new Map(previous)
      next.set(id, value)
      return next
    })
  }

  createEffect(() => {
    const current = overrides()
    if (current.size === 0) return

    let changed = false
    const next = new Map(current)
    for (const setting of props.settings()) {
      if (!next.has(setting.id)) continue
      if (Object.is(setting.get(props.preferences()), next.get(setting.id))) {
        next.delete(setting.id)
        changed = true
      }
    }

    if (changed) setOverrides(next)
  })

  const readValue = (setting: BehaviorSetting) => {
    const current = overrides()
    return current.has(setting.id) ? current.get(setting.id) : setting.get(props.preferences())
  }

  const BehaviorRow: Component<{ setting: BehaviorSetting }> = (rowProps) => {
    const setting = rowProps.setting
    const disabled = createMemo(() => Boolean(setting.disabled?.()))

    if (setting.kind === "toggle") {
      const options = createMemo<SelectOption[]>(() => [
        { value: "true", label: t("settings.common.enabled") },
        { value: "false", label: t("settings.common.disabled") },
      ])
      const selectedOption = createMemo(() => options().find((option) => option.value === String(Boolean(readValue(setting)))))

      return (
        <div class={`settings-toggle-row ${disabled() ? "opacity-60" : ""}`}>
          <div>
            <div class="settings-toggle-title">{t(setting.titleKey)}</div>
            <div class="settings-toggle-caption">{t(setting.subtitleKey)}</div>
          </div>
          <Select<SelectOption>
            value={selectedOption()}
            onChange={async (option) => {
              if (!option) return
              const next = option.value === "true"
              try {
                await setting.set(next)
                setOverride(setting.id, next)
              } catch {
                return
              }
            }}
            options={options()}
            optionValue="value"
            optionTextValue="label"
            disabled={disabled()}
            itemComponent={(itemProps) => (
              <Select.Item item={itemProps.item} class="selector-option">
                <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
              </Select.Item>
            )}
          >
            <Select.Trigger class="selector-trigger" aria-label={t(setting.titleKey)}>
              <div class="flex-1 min-w-0">
                <Select.Value<SelectOption>>
                  {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
                </Select.Value>
              </div>
              <Select.Icon class="selector-trigger-icon">
                <ChevronDown class="w-3 h-3" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content class="selector-popover">
                <Select.Listbox class="selector-listbox" />
              </Select.Content>
            </Select.Portal>
          </Select>
        </div>
      )
    }

    const options = createMemo<SelectOption[]>(() =>
      setting.options.map((option) => ({ value: String(option.value), label: t(option.labelKey) })),
    )
    const selectedOption = createMemo(() => options().find((option) => option.value === String(readValue(setting) ?? "")))

    return (
      <div class={`settings-toggle-row ${disabled() ? "opacity-60" : ""}`}>
        <div>
          <div class="settings-toggle-title">{t(setting.titleKey)}</div>
          <div class="settings-toggle-caption">{t(setting.subtitleKey)}</div>
        </div>
        <Select<SelectOption>
          value={selectedOption()}
          onChange={(option) => {
            if (!option) return
            setOverride(setting.id, option.value)
            setting.set(option.value)
          }}
          options={options()}
          optionValue="value"
          optionTextValue="label"
          disabled={disabled()}
          itemComponent={(itemProps) => (
            <Select.Item item={itemProps.item} class="selector-option">
              <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
            </Select.Item>
          )}
        >
          <Select.Trigger class="selector-trigger" aria-label={t(setting.titleKey)}>
            <div class="flex-1 min-w-0">
              <Select.Value<SelectOption>>
                {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
              </Select.Value>
            </div>
            <Select.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content class="selector-popover">
              <Select.Listbox class="selector-listbox" />
            </Select.Content>
          </Select.Portal>
        </Select>
      </div>
    )
  }

  return <For each={props.settings()}>{(setting) => <BehaviorRow setting={setting} />}</For>
}
