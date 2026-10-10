import type { MissionMap } from "../../../server/src/api-types"
import type { MissionActorActivityState } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import { MissionActionBar } from "./mission-action-bar"
import { createMissionBriefingRequest } from "./mission-briefing"
import { createMissionLifecycle } from "./mission-lifecycle-controls"
import { createMissionRecoveryAction } from "./mission-recovery-button"

/** Lifecycle, update request, coordinator conversation and recovery of the
 * selected one-time Mission. Edit/delete live in the picker line. */
export function MissionSelectedActions(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled: boolean; messagingDisabled: boolean
  coordinatorActivity?: MissionActorActivityState; onOpenCoordinator: () => void; onAdmitted: () => Promise<void>
}) {
  const { t } = useI18n()
  const lifecycle = createMissionLifecycle({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get disabled() { return props.disabled } })
  const briefing = createMissionBriefingRequest({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get active() { return props.active }, get disabled() { return props.messagingDisabled } })
  const recovery = createMissionRecoveryAction({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    target: "coordinator", get activity() { return props.coordinatorActivity },
    get disabled() { return props.disabled || !props.active }, onAdmitted: () => props.onAdmitted() })
  const items = (): ActionOverflowMenuItem[] => {
    const recover = recovery.action()
    return [
      ...lifecycle.menu(),
      ...(briefing.available() && !briefing.waiting() ? [{ key: "briefing", label: t("missionsPanel.action.requestUpdate"),
        disabled: props.messagingDisabled || !props.active, onSelect: () => briefing.ask() }] : []),
      { key: "coordinator", label: t("missionsPanel.action.openConversation"), onSelect: () => props.onOpenCoordinator() },
      ...(recover ? [recover] : []),
    ]
  }
  return <MissionActionBar label={t("missionsPanel.picker.actions")} primary={lifecycle.primary()} items={items()}
    feedback={<>{lifecycle.feedback}{briefing.feedback(() => props.onOpenCoordinator())}{recovery.feedback}</>} />
}
