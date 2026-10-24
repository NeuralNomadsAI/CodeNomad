import Switch from "@suid/material/Switch"
import { Show, type Component } from "solid-js"
import { SettingsInfoTip } from "./settings-info-tip"

interface SettingsSwitchProps {
  checked: boolean
  /** Accessible name; the visible row title usually carries the same text. */
  label: string
  disabled?: boolean
  describedBy?: string
  onChange: (checked: boolean) => void
}

/** On/off control for a lone setting: the Yolo switch, in the plain accent color. */
export const SettingsSwitch: Component<SettingsSwitchProps> = (props) => (
  <Switch
    class="settings-switch"
    checked={props.checked}
    disabled={props.disabled}
    size="small"
    sx={{
      "& .MuiSwitch-switchBase.Mui-checked": { color: "var(--accent-primary)" },
      "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: "var(--accent-primary)" },
    }}
    inputProps={{ role: "switch", "aria-label": props.label, "aria-describedby": props.describedBy }}
    onChange={(_event, checked) => props.onChange(Boolean(checked))}
  />
)

interface SettingsChoiceRowProps {
  checked: boolean
  title: string
  caption?: string
  /** Secondary explanation behind an "i" beside the title instead of a caption. */
  info?: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** One on/off setting among several grouped ones: a checkbox in the row's control column. */
export const SettingsChoiceRow: Component<SettingsChoiceRowProps> = (props) => (
  <label class="settings-toggle-row settings-choice-row" classList={{ "opacity-60": Boolean(props.disabled) }}>
    <span>
      <span class="settings-toggle-title">{props.title}<Show when={props.info}>{(info) => <SettingsInfoTip text={info()} />}</Show></span>
      <Show when={props.caption}><span class="settings-toggle-caption">{props.caption}</span></Show>
    </span>
    <input
      type="checkbox"
      aria-label={props.title}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => {
        const next = event.currentTarget.checked
        // The owner's value stays authoritative until it confirms the change.
        event.currentTarget.checked = props.checked
        props.onChange(next)
      }}
    />
  </label>
)
