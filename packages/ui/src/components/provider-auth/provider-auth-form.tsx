import { Select } from "@kobalte/core/select"
import type { FormAnswer, FormField, FormFields, FormValue } from "@opencode-ai/client"
import { ChevronDown, ExternalLink } from "lucide-solid"
import { createMemo, For, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { shouldShowProviderAuthField } from "../../lib/provider-auth"

type Option = { label: string; value: string; description?: string }

export const ProviderAuthForm: Component<{
  fields?: FormFields
  answer: FormAnswer
  disabled?: boolean
  onAnswer: (key: string, value: FormValue | undefined) => void
}> = (props) => {
  const { t } = useI18n()
  const visibleFields = createMemo(() => (props.fields ?? []).filter((field) => shouldShowProviderAuthField(field, props.answer)))

  const title = (field: FormField) => field.title || field.key
  const selected = (field: FormField) => props.answer[field.key]
  const selectedStrings = (field: FormField) => Array.isArray(selected(field)) ? selected(field) as string[] : []
  const inputType = (field: FormField) => {
    if (field.type !== "string") return "text"
    if (field.format === "uri") return "url"
    if (field.format === "date-time") return "datetime-local"
    return field.format ?? "text"
  }
  const numericBound = (value: number | string | undefined) => typeof value === "number" && Number.isFinite(value) ? value : undefined

  const updateMultiselect = (field: Extract<FormField, { type: "multiselect" }>, value: string, checked: boolean) => {
    const values = new Set(selectedStrings(field))
    checked ? values.add(value) : values.delete(value)
    props.onAnswer(field.key, [...values])
  }

  const updateCustomMultiselect = (field: Extract<FormField, { type: "multiselect" }>, value: string) => {
    const options = new Set(field.options.map((option) => option.value))
    const selectedOptions = selectedStrings(field).filter((item) => options.has(item))
    const custom = value.split(",").map((item) => item.trim()).filter(Boolean)
    props.onAnswer(field.key, [...selectedOptions, ...custom])
  }

  return (
    <div class="providers-form-stack">
      <For each={visibleFields()}>{(field) => (
        <Show
          when={field.type !== "external"}
          fallback={(
            <div class="providers-field">
              <a href={field.type === "external" ? field.url : ""} target="_blank" rel="noopener noreferrer" class="selector-button selector-button-secondary providers-oauth-link">
                <ExternalLink class="w-4 h-4" />
                {title(field)}
              </a>
              <Show when={field.description}><span class="settings-toggle-caption">{field.description}</span></Show>
            </div>
          )}
        >
          <div class="providers-field">
            <Show when={field.type !== "boolean"}>
              <label class="settings-form-label" for={`provider-field-${field.key}`}>{title(field)}</label>
            </Show>
            <Show when={field.description}><span class="settings-toggle-caption">{field.description}</span></Show>

            <Show when={field.type === "string" && (!field.options || field.custom)}>
              <input
                id={`provider-field-${field.key}`}
                type={inputType(field)}
                class="providers-input"
                value={typeof selected(field) === "string" ? selected(field) as string : ""}
                placeholder={field.type === "string" ? field.placeholder : undefined}
                required={field.type === "string" ? field.required : undefined}
                minlength={field.type === "string" ? field.minLength : undefined}
                maxlength={field.type === "string" ? field.maxLength : undefined}
                pattern={field.type === "string" ? field.pattern : undefined}
                list={field.type === "string" && field.options ? `provider-options-${field.key}` : undefined}
                disabled={props.disabled}
                onInput={(event) => props.onAnswer(field.key, event.currentTarget.value)}
              />
              <Show when={field.type === "string" && field.options}>
                <datalist id={`provider-options-${field.key}`}>
                  <For each={field.type === "string" ? field.options : []}>{(option) => <option value={option.value}>{option.label}</option>}</For>
                </datalist>
              </Show>
            </Show>

            <Show when={field.type === "string" && field.options && !field.custom}>
              <Select<Option>
                value={field.type === "string" ? field.options?.find((option) => option.value === selected(field)) : undefined}
                onChange={(option) => props.onAnswer(field.key, option?.value)}
                options={field.type === "string" ? field.options ?? [] : []}
                optionValue="value"
                optionTextValue="label"
                disabled={props.disabled}
                itemComponent={(itemProps) => <Select.Item item={itemProps.item} class="selector-option"><Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}<Show when={itemProps.item.rawValue.description}><span class="providers-select-hint">{itemProps.item.rawValue.description}</span></Show></Select.ItemLabel></Select.Item>}
              >
                <Select.Trigger class="selector-trigger providers-prompt-trigger" aria-label={title(field)}>
                  <div class="flex-1 min-w-0"><Select.Value<Option>>{(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label ?? t("settings.providers.prompt.selectPlaceholder")}</span>}</Select.Value></div>
                  <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
                </Select.Trigger>
                <Select.Portal><Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content></Select.Portal>
              </Select>
            </Show>

            <Show when={field.type === "number" || field.type === "integer"}>
              <input
                id={`provider-field-${field.key}`}
                type="number"
                class="providers-input"
                value={typeof selected(field) === "number" ? selected(field) as number : ""}
                min={field.type === "number" || field.type === "integer" ? numericBound(field.minimum) : undefined}
                max={field.type === "number" || field.type === "integer" ? numericBound(field.maximum) : undefined}
                step={field.type === "integer" ? 1 : "any"}
                required={field.type === "number" || field.type === "integer" ? field.required : undefined}
                disabled={props.disabled}
                onInput={(event) => props.onAnswer(field.key, event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)}
              />
            </Show>

            <Show when={field.type === "boolean"}>
              <label class="settings-checkbox-toggle">
                <input type="checkbox" checked={selected(field) === true} disabled={props.disabled} onChange={(event) => props.onAnswer(field.key, event.currentTarget.checked)} />
                <span>{title(field)}</span>
              </label>
            </Show>

            <Show when={field.type === "multiselect"}>
              <div class="providers-multiselect">
                <For each={field.type === "multiselect" ? field.options : []}>{(option) => (
                  <label class="settings-checkbox-toggle">
                    <input type="checkbox" checked={selectedStrings(field).includes(option.value)} disabled={props.disabled} onChange={(event) => field.type === "multiselect" && updateMultiselect(field, option.value, event.currentTarget.checked)} />
                    <span>{option.label}</span>
                  </label>
                )}</For>
                <Show when={field.type === "multiselect" && field.custom}>
                  <input
                    type="text"
                    class="providers-input"
                    value={field.type === "multiselect" ? selectedStrings(field).filter((value) => !field.options.some((option) => option.value === value)).join(", ") : ""}
                    placeholder={t("settings.providers.prompt.customValuesPlaceholder")}
                    disabled={props.disabled}
                    onInput={(event) => field.type === "multiselect" && updateCustomMultiselect(field, event.currentTarget.value)}
                  />
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      )}</For>
    </div>
  )
}
