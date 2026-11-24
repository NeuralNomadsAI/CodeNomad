import { Select } from "@kobalte/core/select"
import { ChevronDown, Languages } from "lucide-solid"
import type { Component } from "solid-js"
import { useI18n, type Locale } from "../lib/i18n"
import { useConfig } from "../stores/preferences"

type LanguageOption = { value: Locale; label: string }

const languageOptions: LanguageOption[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "ru", label: "Русский" },
  { value: "ja", label: "日本語" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "he", label: "עברית" },
  { value: "de", label: "Deutsch" },
  { value: "ne", label: "नेपाली" },
  { value: "tr", label: "Türkçe" },
]

export const LocaleSelector: Component = () => {
  const { t, locale } = useI18n()
  const { updatePreferences } = useConfig()
  const selectedOption = () => languageOptions.find((option) => option.value === locale()) ?? languageOptions[0]

  return (
    <Select<LanguageOption>
      value={selectedOption()}
      onChange={(option) => {
        if (!option || option.value === locale()) return
        updatePreferences({ locale: option.value })
      }}
      options={languageOptions}
      optionValue="value"
      optionTextValue="label"
      itemComponent={(itemProps) => (
        <Select.Item item={itemProps.item} class="selector-option">
          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Trigger
        class="selector-trigger"
        aria-label={t("folderSelection.language.ariaLabel")}
        title={t("folderSelection.language.ariaLabel")}
      >
        <Languages class="w-4 h-4 icon-muted" aria-hidden="true" />
        <div class="flex-1 min-w-0">
          <Select.Value<LanguageOption>>
            {(state) => (
              <span class="selector-trigger-primary selector-trigger-primary--align-left">
                {state.selectedOption()?.label}
              </span>
            )}
          </Select.Value>
        </div>
        <Select.Icon class="selector-trigger-icon">
          <ChevronDown class="w-3 h-3" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content class="selector-popover min-w-[180px]">
          <Select.Listbox class="selector-listbox" />
        </Select.Content>
      </Select.Portal>
    </Select>
  )
}
