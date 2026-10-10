import { For, Show } from "solid-js"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { useI18n } from "../lib/i18n"
import { groupMissionProfileSummary, missionExecutionLabel } from "./mission-profile-summary-data"

/** Requested IDs only; no catalog read and no claim about an actor's live profile. */
export function MissionProfileSummary(props: { profiles?: MissionProfiles; template: MissionTemplateId }) {
  const { t } = useI18n()
  const groups = () => groupMissionProfileSummary(props.profiles, props.template)
  return <p class="mission-profile-summary" aria-label={t("missions.defaults.summary")}>
    <Show when={groups().length === 1 && !groups()[0].execution} fallback={
    <For each={groups()}>{({ roles, execution }, index) => <>
      {index() ? " · " : ""}{roles.map(role => t(`missions.control.profiles.role.${role}`)).join(", ")}: {missionExecutionLabel(execution) ?? t("missions.control.execution.nativeDefault")}
    </>}</For>
    }>{t("missions.simple.profilesNative")}</Show>
  </p>
}
