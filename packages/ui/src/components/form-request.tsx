import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { FormAnswer, FormField, FormInfo, FormValue } from "@opencode-ai/client"
import { useI18n } from "../lib/i18n"
import { isFormFieldVisible, isHttpFormUrl } from "../lib/form-schema"

interface FormRequestProps {
  form: FormInfo
  onReply: (answer: FormAnswer) => Promise<void>
  onCancel: () => Promise<void>
}

export function getFormFieldDefaultValue(field: FormField): FormValue | undefined {
  if (field.type === "external") return undefined
  if (field.type === "boolean") return field.default ?? false
  return field.default
}

export function getFormStringInputType(format: Extract<FormField, { type: "string" }>["format"]): string {
  if (format === "uri") return "url"
  if (format === "date-time") return "datetime-local"
  return format || "text"
}

export function formatFormStringInputValue(format: Extract<FormField, { type: "string" }>["format"], value: string): string {
  if (format !== "date-time" || !value) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function normalizeFormStringValue(
  format: Extract<FormField, { type: "string" }>["format"],
  value: string,
): string | undefined {
  if (format !== "date-time" || !value) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function shouldRenderFormOptionsInline(options: readonly unknown[] | undefined): boolean {
  return Boolean(options?.length && options.length <= 4)
}

export function shouldRenderFormOptionsAsSelect(options: readonly unknown[] | undefined): boolean {
  return Boolean(options?.length && !shouldRenderFormOptionsInline(options))
}

const FormRequest: Component<FormRequestProps> = (props) => {
  const { t } = useI18n()
  const [values, setValues] = createSignal<Record<string, FormValue | undefined>>(
    Object.fromEntries(props.form.fields.map((field) => [field.key, getFormFieldDefaultValue(field)])),
  )
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const visibleFields = createMemo(() => props.form.fields.filter((field) => isFormFieldVisible(field, values())))

  const update = (key: string, value: FormValue | undefined) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.reportValidity()) return
    const invalidCollection = visibleFields().find((field) => {
      const value = values()[field.key]
      if (field.type === "external") return false
      if (field.type === "string") return field.required && (typeof value !== "string" || value.length === 0)
      if (field.type === "number" || field.type === "integer") return field.required && typeof value !== "number"
      if (field.type === "boolean") return field.required && value === undefined
      const count = Array.isArray(value) ? value.length : 0
      return (field.required && count === 0) || count < (field.minItems ?? 0) || count > (field.maxItems ?? Infinity)
    })
    if (invalidCollection) {
      setError(t("formRequest.errors.validation"))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const visibleKeys = new Set(visibleFields().map((field) => field.key))
      const answer = Object.fromEntries(
        Object.entries(values()).filter(([key, value]) => visibleKeys.has(key) && value !== undefined),
      ) as FormAnswer
      await props.onReply(answer)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("formRequest.errors.reply"))
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await props.onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("formRequest.errors.cancel"))
      setSubmitting(false)
    }
  }

  return (
    <form class="form-request" onSubmit={submit} aria-label={props.form.title}>
      <h3 class="form-request-title">{props.form.title}</h3>
      <For each={visibleFields()}>
        {(field) => {
          const descriptionId = `form-${props.form.id}-${field.key}-description`
          const label = () => field.title || field.key
          const stringField = field as Extract<FormField, { type: "string" }>
          const numberField = field as Extract<FormField, { type: "number" | "integer" }>
          const stringOptions = () => stringField.options ?? []
          const selectedString = () => String(values()[field.key] ?? "")
          const customString = () => stringOptions().some((option) => option.value === selectedString()) ? "" : selectedString()
          return (
            <div class="form-request-field">
              <Show when={
                field.type === "external"
                || field.type === "multiselect"
                || (field.type === "string" && shouldRenderFormOptionsInline(stringField.options))
              } fallback={
                <label class="form-request-label" for={`form-${props.form.id}-${field.key}`}>
                  {label()}
                  <Show when={"required" in field && field.required}> <span class="form-request-required" aria-hidden="true">*</span></Show>
                </label>
              }>
                <span class="form-request-label">
                  {label()}
                  <Show when={"required" in field && field.required}> <span class="form-request-required" aria-hidden="true">*</span></Show>
                </span>
              </Show>
              <Show when={field.description}>
                <p id={descriptionId} class="form-request-description">{field.description}</p>
              </Show>
              <Show when={field.type === "string"}>
                <Show when={shouldRenderFormOptionsInline(stringField.options)} fallback={
                  <>
                    <Show when={shouldRenderFormOptionsAsSelect(stringField.options)} fallback={
                      <input
                        id={`form-${props.form.id}-${field.key}`}
                        class="form-request-input"
                        type={getFormStringInputType(stringField.format)}
                        value={formatFormStringInputValue(stringField.format, String(values()[field.key] ?? ""))}
                        required={stringField.required}
                        minLength={stringField.minLength}
                        maxLength={stringField.maxLength}
                        pattern={stringField.pattern}
                        placeholder={stringField.placeholder}
                        list={stringField.options?.length ? `form-${props.form.id}-${field.key}-options` : undefined}
                        aria-describedby={field.description ? descriptionId : undefined}
                        onInput={(event) => update(field.key, normalizeFormStringValue(stringField.format, event.currentTarget.value))}
                      />
                    }>
                      <select
                        id={`form-${props.form.id}-${field.key}`}
                        class="form-request-input"
                        required={stringField.required}
                        value={String(values()[field.key] ?? "")}
                        aria-describedby={field.description ? descriptionId : undefined}
                        onChange={(event) => update(field.key, event.currentTarget.value)}
                      >
                        <option value="">{t("formRequest.selectPlaceholder")}</option>
                        <For each={stringField.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
                      </select>
                    </Show>
                    <Show when={stringField.custom && shouldRenderFormOptionsAsSelect(stringField.options)}>
                      <input
                        class="form-request-input"
                        type="text"
                        value={customString()}
                        placeholder={t("formRequest.customValuesPlaceholder")}
                        aria-describedby={field.description ? descriptionId : undefined}
                        onInput={(event) => update(field.key, event.currentTarget.value || undefined)}
                      />
                    </Show>
                  </>
                }>
                  <fieldset class="form-request-options" aria-describedby={field.description ? descriptionId : undefined}>
                    <legend class="sr-only">{label()}</legend>
                    <For each={stringOptions()}>{(option) => {
                      const checked = () => selectedString() === option.value
                      return (
                        <label class="form-request-choice" data-selected={checked() ? "true" : undefined}>
                          <input
                            class="form-request-choice-control"
                            type="radio"
                            name={`form-${props.form.id}-${field.key}`}
                            checked={checked()}
                            onChange={() => update(field.key, option.value)}
                          />
                          <span class="form-request-choice-copy">
                            <span class="form-request-choice-label">{option.label}</span>
                            <Show when={option.description}>
                              <span class="form-request-choice-description">{option.description}</span>
                            </Show>
                          </span>
                        </label>
                      )
                    }}</For>
                  </fieldset>
                  <Show when={stringField.custom}>
                    <input
                      id={`form-${props.form.id}-${field.key}`}
                      class="form-request-input"
                      type="text"
                      value={customString()}
                      placeholder={t("formRequest.customValuesPlaceholder")}
                      aria-describedby={field.description ? descriptionId : undefined}
                      onInput={(event) => update(field.key, event.currentTarget.value || undefined)}
                    />
                  </Show>
                </Show>
              </Show>
              <Show when={field.type === "number" || field.type === "integer"}>
                <input
                  id={`form-${props.form.id}-${field.key}`}
                  class="form-request-input"
                  type="number"
                  step={field.type === "integer" ? 1 : "any"}
                  value={String(values()[field.key] ?? "")}
                  required={numberField.required}
                  min={numberField.minimum}
                  max={numberField.maximum}
                  aria-describedby={field.description ? descriptionId : undefined}
                  onInput={(event) => update(field.key, event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)}
                />
              </Show>
              <Show when={field.type === "boolean"}>
                <input
                  id={`form-${props.form.id}-${field.key}`}
                  class="form-request-checkbox"
                  type="checkbox"
                  checked={values()[field.key] === true}
                  aria-describedby={field.description ? descriptionId : undefined}
                  onChange={(event) => update(field.key, event.currentTarget.checked)}
                />
              </Show>
              <Show when={field.type === "multiselect"}>
                <fieldset class="form-request-options" aria-describedby={field.description ? descriptionId : undefined}>
                  <legend class="sr-only">{label()}</legend>
                  <For each={field.type === "multiselect" ? field.options : []}>{(option) => (
                    <label
                      class="form-request-choice"
                      data-selected={Array.isArray(values()[field.key]) && (values()[field.key] as string[]).includes(option.value) ? "true" : undefined}
                    >
                      <input
                        type="checkbox"
                        class="form-request-choice-control"
                        checked={Array.isArray(values()[field.key]) && (values()[field.key] as string[]).includes(option.value)}
                        onChange={(event) => {
                          const current = Array.isArray(values()[field.key]) ? values()[field.key] as string[] : []
                          update(field.key, event.currentTarget.checked
                            ? [...current, option.value]
                            : current.filter((value) => value !== option.value))
                        }}
                      />
                      <span class="form-request-choice-copy">
                        <span class="form-request-choice-label">{option.label}</span>
                        <Show when={option.description}>
                          <span class="form-request-choice-description">{option.description}</span>
                        </Show>
                      </span>
                    </label>
                  )}</For>
                </fieldset>
                <Show when={field.type === "multiselect" && field.custom}>
                  <input
                    class="form-request-input"
                    type="text"
                    placeholder={t("formRequest.customValuesPlaceholder")}
                    onChange={(event) => {
                      const custom = event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean)
                      const selected = Array.isArray(values()[field.key]) ? values()[field.key] as string[] : []
                      const options = new Set(field.type === "multiselect" ? field.options.map((option) => option.value) : [])
                      update(field.key, [...selected.filter((value) => options.has(value)), ...custom])
                    }}
                  />
                </Show>
              </Show>
              <Show when={field.type === "external" && isHttpFormUrl(field.url)}>
                <a class="form-request-link" href={field.type === "external" ? field.url : ""} target="_blank" rel="noreferrer">
                  {t("formRequest.openExternal")}
                </a>
              </Show>
            </div>
          )
        }}
      </For>
      <Show when={error()}>{(message) => <p class="form-request-error" role="alert">{message()}</p>}</Show>
      <div class="form-request-actions">
        <button type="button" class="selector-button selector-button-secondary" disabled={submitting()} onClick={() => void cancel()}>
          {t("formRequest.cancel")}
        </button>
        <button type="submit" class="selector-button selector-button-primary" disabled={submitting()}>
          {submitting() ? t("formRequest.submitting") : t("formRequest.submit")}
        </button>
      </div>
    </form>
  )
}

export default FormRequest
