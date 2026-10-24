import { Select } from "@kobalte/core/select"
import { createMemo, For, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ChevronDown } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { useConfig, type VisibilityPreference } from "../../stores/preferences"
import { getMessageContentIcon } from "../message-content-icons"
import {
  TRANSCRIPT_PRESETS,
  transcriptPreset,
  transcriptPresetPatch,
  transcriptVisibility,
  transcriptVisibilityPatch,
  transcriptVisibilityRows,
  type TranscriptVisibilityRow as VisibilityRow,
} from "../transcript-visibility"

type SelectOption = { value: VisibilityPreference; label: string }

export const ChatSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()

  const visibilityOptions = createMemo<SelectOption[]>(() => [
    { value: "hidden", label: t("commands.common.hidden") },
    { value: "collapsed", label: t("commands.common.collapsed") },
    { value: "expanded", label: t("commands.common.expanded") },
  ])

  const visibilityRows = createMemo(() => transcriptVisibilityRows(t))
  const currentPreset = createMemo(() => transcriptPreset(preferences()))

  const setVisibilityRowMode = (row: VisibilityRow, mode: VisibilityPreference) => {
    updatePreferences(transcriptVisibilityPatch(preferences(), row, mode))
  }

  const rowMode = (row: VisibilityRow) => transcriptVisibility(preferences(), row)

  const selectedVisibilityOption = (mode: VisibilityPreference) =>
    visibilityOptions().find((option) => option.value === mode)

  return (
    <div class="settings-section-stack chat-settings">
      <section class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.behavior.expansionPresets.ariaLabel")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.behavior.subtitle")}</p>
          </div>
        </div>

        <div class="settings-expansion-presets" aria-label={t("settings.behavior.expansionPresets.ariaLabel")}>
          <For each={TRANSCRIPT_PRESETS}>
            {(preset) => (
              <button
                type="button"
                class="settings-expansion-preset"
                data-selected={currentPreset() === preset ? "true" : "false"}
                aria-pressed={currentPreset() === preset}
                onClick={() => updatePreferences(transcriptPresetPatch(preset))}
              >
                <span class="settings-expansion-preset-title">{t(`settings.behavior.expansionPreset.${preset}.title`)}</span>
                <span class="settings-expansion-preset-copy">{t(`settings.behavior.expansionPreset.${preset}.description`)}</span>
              </button>
            )}
          </For>
        </div>

        <div class="settings-expansion-table" role="table" aria-label={t("settings.behavior.expansionDefaults.title")}>
          <div class="settings-expansion-table-header" role="row">
            <span role="columnheader">{t("settings.behavior.expansionDefaults.itemColumn")}</span>
            <span role="columnheader">{t("settings.behavior.expansionDefaults.stateColumn")}</span>
          </div>
          <For each={visibilityRows()}>
            {(row) => {
              const selected = createMemo(() => selectedVisibilityOption(rowMode(row)))
              return (
                <div class="settings-expansion-row" role="row">
                  <div class="settings-expansion-row-label flex items-center gap-2" role="cell">
                    <Dynamic component={getMessageContentIcon(row.key)} class="w-4 h-4 shrink-0 text-secondary" aria-hidden="true" />
                    <code>{row.label}</code>
                  </div>
                  <div class="settings-expansion-row-control" role="cell">
                    <Select<SelectOption>
                      value={selected()}
                      onChange={(option) => option && setVisibilityRowMode(row, option.value)}
                      options={visibilityOptions()}
                      optionValue="value"
                      optionTextValue="label"
                      itemComponent={(itemProps) => (
                        <Select.Item item={itemProps.item} class="selector-option">
                          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                        </Select.Item>
                      )}
                    >
                      <Select.Trigger
                        class="selector-trigger settings-expansion-select"
                        aria-label={t("settings.behavior.expansionDefaults.rowAriaLabel", { item: row.label })}
                      >
                        <div class="flex-1 min-w-0">
                          <Select.Value<SelectOption>>
                            {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
                          </Select.Value>
                        </div>
                        <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content>
                      </Select.Portal>
                    </Select>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </section>
    </div>
  )
}
