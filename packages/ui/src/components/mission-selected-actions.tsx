import type { MissionMap } from "../../../server/src/api-types"
import type { MissionActorActivityState } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import { MissionActionBar } from "./mission-action-bar"
import { createMissionBriefingRequest } from "./mission-briefing"
import { createMissionLifecycle } from "./mission-lifecycle-controls"
import { createMissionRecoveryAction } from "./mission-recovery-button"

/** Summary reader, lifecycle, coordinator conversation, update request and
 * recovery, edit and delete of the selected one-time Mission. */
export function MissionSelectedActions(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled: boolean; messagingDisabled: boolean
  reading: boolean; onToggleReader: () => void
  coordinatorActivity?: MissionActorActivityState; onOpenCoordinator: () => void; onAdmitted: () => Promise<void>
  onEdit: () => void; onDelete: () => void; editDisabled: boolean; deleteDisabled: boolean
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
      ...(recover ? [recover] : []),
    ]
  }
  return <MissionActionBar label={t("missionsPanel.picker.actions")} reading={props.reading} onToggleReader={props.onToggleReader}
    primary={lifecycle.primary()} stop={lifecycle.stop()} onOpenConversation={() => props.onOpenCoordinator()}
    onEdit={() => props.onEdit()} onDelete={() => props.onDelete()} editDisabled={props.editDisabled} deleteDisabled={props.deleteDisabled} items={items()}
    feedback={<>{lifecycle.feedback}{briefing.feedback(() => props.onOpenCoordinator())}{recovery.feedback}</>} />
}
