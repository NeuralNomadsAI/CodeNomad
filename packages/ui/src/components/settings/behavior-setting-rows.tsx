import { Select } from "@kobalte/core/select"
import { ChevronDown } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Show, type Accessor, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import type { BehaviorSetting } from "../../lib/settings/behavior-registry"
import type { Preferences } from "../../stores/preferences"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsChoiceRow, SettingsSwitch } from "./settings-switch"

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

  // Several on/off settings together read as a checklist; a lone one keeps a switch.
  const groupedToggles = createMemo(() => props.settings().filter((setting) => setting.kind === "toggle").length > 1)

  const readValue = (setting: BehaviorSetting) => {
    const current = overrides()
    return current.has(setting.id) ? current.get(setting.id) : setting.get(props.preferences())
  }

  const BehaviorRow: Component<{ setting: BehaviorSetting }> = (rowProps) => {
    const setting = rowProps.setting
    const disabled = createMemo(() => Boolean(setting.disabled?.()))

    if (setting.kind === "toggle" && groupedToggles()) {
      return (
        <SettingsChoiceRow
          checked={Boolean(readValue(setting))}
          title={t(setting.titleKey)}
          caption={setting.subtitleKey ? t(setting.subtitleKey) : undefined}
          info={setting.infoKey ? t(setting.infoKey) : undefined}
          disabled={disabled()}
          onChange={async (next) => {
            try {
              await setting.set(next)
              setOverride(setting.id, next)
            } catch {
              return
            }
          }}
        />
      )
    }

    if (setting.kind === "toggle") {
      return (
        <div class={`settings-toggle-row ${disabled() ? "opacity-60" : ""}`}>
          <div>
            <div class="settings-toggle-title">{t(setting.titleKey)}<Show when={setting.infoKey}>{(key) => <SettingsInfoTip text={t(key())} />}</Show></div>
            <Show when={setting.subtitleKey}>{(key) => <div class="settings-toggle-caption">{t(key())}</div>}</Show>
          </div>
          <SettingsSwitch
            checked={Boolean(readValue(setting))}
            label={t(setting.titleKey)}
            disabled={disabled()}
            onChange={async (next) => {
              try {
                await setting.set(next)
                setOverride(setting.id, next)
              } catch {
                return
              }
            }}
          />
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
          <div class="settings-toggle-title">{t(setting.titleKey)}<Show when={setting.infoKey}>{(key) => <SettingsInfoTip text={t(key())} />}</Show></div>
          <Show when={setting.subtitleKey}>{(key) => <div class="settings-toggle-caption">{t(key())}</div>}</Show>
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
