import { Show, createUniqueId, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import type { MissionTaskMode } from "../lib/mission-defaults"

/** A requested policy for new Mission tasks, not a global subagent setting. */
export function MissionTaskModeControls(props: { value?: MissionTaskMode; disabled: boolean; onChange: (value: MissionTaskMode) => void; onInherit?: () => void; inheritLabel?: string; children?: JSX.Element }) {
  const { t } = useI18n(), description = createUniqueId()
  return <fieldset class="mission-delegation">
    <legend>{t("missions.taskMode.title")}</legend>
    <label>{t("missions.taskMode.label")}<select value={props.value ?? "inherit"} disabled={props.disabled} aria-label={t("missions.taskMode.label")} aria-describedby={description}
      title={t("missions.taskMode.hint")} onChange={event => event.currentTarget.value === "inherit" ? props.onInherit?.() : props.onChange(event.currentTarget.value as MissionTaskMode)}>
      <Show when={props.onInherit}><option value="inherit" selected={props.value === undefined}>{props.inheritLabel ?? t("missions.defaults.inherit")}</option></Show>
      <option value="native" selected={props.value === "native"}>{t("missions.taskMode.native")}</option>
      <option value="independent" selected={props.value === "independent"}>{t("missions.taskMode.independent")}</option>
    </select></label>
    <span id={description} class="sr-only">{t("missions.taskMode.hint")}</span>
    {props.children}
  </fieldset>
}
