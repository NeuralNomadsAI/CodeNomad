import { For } from "solid-js"
import { missionProfileRoles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { useI18n } from "../lib/i18n"
import { missionExecutionLabel } from "./mission-profile-summary-data"

/** Omission inherits; an explicit empty execution requests the native default. */
export function preserveNativeDefaultOverrides(previous: MissionProfiles | undefined, next: MissionProfiles | undefined): MissionProfiles {
  const result: MissionProfiles = { ...next, roles: { ...next?.roles } }
  if (previous?.coordinator && !next?.coordinator) result.coordinator = {}
  for (const role of Object.keys(previous?.roles ?? {})) if (!next?.roles?.[role]) result.roles![role] = {}
  return result
}

export function MissionDefaultInheritanceControls(props: {
  template: MissionTemplateId; profiles?: MissionProfiles; inherited?: MissionProfiles; disabled: boolean
  onChange: (profiles: MissionProfiles) => void
}) {
  const { t } = useI18n()
  const selection = (role: string) => role === "coordinator" ? props.profiles?.coordinator : props.profiles?.roles?.[role]
  const inherited = (role: string) => missionExecutionLabel(role === "coordinator" ? props.inherited?.coordinator : props.inherited?.roles?.[role])
    ?? t("missions.control.execution.nativeDefault")
  return <div class="mission-default-inheritance" title={t("missions.defaults.inheritanceHint")} aria-description={t("missions.defaults.inheritanceHint")}>
    <For each={["coordinator", ...missionProfileRoles[props.template]]}>{role => {
      const mode = () => selection(role) === undefined ? "inherit" : selection(role)?.agent || selection(role)?.model ? "selected" : "native"
      return <label>{t(`missions.control.profiles.role.${role}`)}<select aria-label={t("missions.defaults.inheritanceLabel", { role: t(`missions.control.profiles.role.${role}`) })}
        value={mode()} disabled={props.disabled} onChange={event => {
          const inherit = event.currentTarget.value === "inherit", next = { ...props.profiles, roles: { ...props.profiles?.roles } }
          if (role === "coordinator") { if (inherit) delete next.coordinator; else next.coordinator = {} }
          else { if (inherit) delete next.roles[role]; else next.roles[role] = {} }
          props.onChange(next)
        }}>
        <option value="inherit">{t("missions.defaults.inheritGlobal", { value: inherited(role) })}</option>
        <option value="native">{t("missions.control.execution.nativeDefault")}</option>
        <option value="selected" disabled>{t("missions.defaults.selected")}</option>
      </select></label>
    }}</For>
  </div>
}
