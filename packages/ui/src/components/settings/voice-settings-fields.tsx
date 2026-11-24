import { For, Show, createSignal, createUniqueId, type ParentComponent } from "solid-js"
import { useI18n } from "../../lib/i18n"
import type { VoiceSettingsRowId } from "../../stores/settings-screen"
import { SettingsInfoTip } from "./settings-info-tip"
import { useSettingsRowTarget } from "./settings-row-target"

export const VoiceSettingsCard: ParentComponent<{
  id: VoiceSettingsRowId
  title: string
  status: string
  settled: boolean
}> = (props) => {
  const [heading, setHeading] = createSignal<HTMLHeadingElement>()
  useSettingsRowTarget(props.id, heading, () => props.settled)
  return (
    <section class="settings-card" aria-labelledby={props.id}>
      <div class="settings-card-header">
        <h3 class="settings-card-title" id={props.id} ref={setHeading} tabindex="-1">{props.title}</h3>
        <span class="settings-inline-note max-w-[60%] break-words text-end" role="status">{props.status}</span>
      </div>
      <div class="settings-stack">{props.children}</div>
    </section>
  )
}

export function VoiceTextField(props: {
  label: string
  info?: string
  value: string
  placeholder?: string
  disabled?: boolean
  secret?: boolean
  onInput: (value: string) => void
}) {
  const label = createUniqueId()
  return (
    <label class="settings-toggle-row settings-toggle-row-compact">
      <span class="settings-toggle-title">
        <span id={label}>{props.label}</span>
        <Show when={props.info}>{info => <SettingsInfoTip text={info()} help={{ page: "voice", anchor: "configure" }} />}</Show>
      </span>
      <input
        type={props.secret ? "password" : "text"}
        aria-labelledby={label}
        autocomplete={props.secret ? "new-password" : "off"}
        value={props.value}
        onInput={event => props.onInput(event.currentTarget.value)}
        class="selector-input w-full min-w-0 sm:max-w-[24rem]"
        placeholder={props.placeholder}
        disabled={props.disabled}
      />
    </label>
  )
}

export function VoiceSelectField<T extends string>(props: {
  label: string
  info?: string
  value: T
  disabled?: boolean
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>
  onChange: (value: T) => void
}) {
  const label = createUniqueId()
  return (
    <label class="settings-toggle-row settings-toggle-row-compact">
      <span class="settings-toggle-title">
        <span id={label}>{props.label}</span>
        <Show when={props.info}>{info => <SettingsInfoTip text={info()} help={{ page: "voice", anchor: "configure" }} />}</Show>
      </span>
      <select
        class="selector-input w-full min-w-0 sm:max-w-[24rem]"
        aria-labelledby={label}
        disabled={props.disabled}
        onChange={event => {
          const selected = props.options.find(option => option.value === event.currentTarget.value && !option.disabled)
          event.currentTarget.value = props.value
          if (selected) props.onChange(selected.value)
        }}
      >
        <For each={props.options}>{option =>
          <option value={option.value} selected={option.value === props.value} disabled={option.disabled}>{option.label}</option>
        }</For>
      </select>
    </label>
  )
}

export function VoiceSave(props: { dirty: boolean; saving: boolean; error?: string }) {
  const { t } = useI18n()
  return (
    <div class="settings-toolbar-inline flex-wrap">
      <button type="submit" class="selector-button selector-button-primary w-auto" disabled={!props.dirty || props.saving}>
        {t(props.saving ? "settings.speech.save.saving" : "settings.speech.save.action")}
      </button>
      <Show when={props.error}>{error => <span class="settings-inline-note" role="alert">{error()}</span>}</Show>
    </div>
  )
}
