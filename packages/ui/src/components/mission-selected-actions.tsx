import { onCleanup } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionActorActivityState } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionActionBar } from "./mission-action-bar"
import { createMissionBriefingRequest } from "./mission-briefing"
import { createMissionLifecycle, type MissionControlRetry, type MissionPrimaryAction } from "./mission-lifecycle-controls"
import { createMissionRecoveryAction } from "./mission-recovery-button"

/** Summary reader, lifecycle (with coordinator recovery on Play), update
 * request, coordinator conversation, edit and delete of the selected one-time
 * Mission. An unconfirmed lifecycle control is resent only through the panel's
 * explicit refresh, registered here. */
export function MissionSelectedActions(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled: boolean; messagingDisabled: boolean
  reading: boolean; onToggleReader: () => void
  coordinatorActivity?: MissionActorActivityState; onOpenCoordinator: () => void; onAdmitted: () => Promise<void>
  onEdit: () => void; onDelete: () => void; editDisabled: boolean; deleteDisabled: boolean
  registerRetry?: (retry: MissionControlRetry) => () => void
}) {
  const { t } = useI18n()
  const lifecycle = createMissionLifecycle({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get disabled() { return props.disabled } })
  const briefing = createMissionBriefingRequest({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get active() { return props.active }, get disabled() { return props.messagingDisabled } })
  const recovery = createMissionRecoveryAction({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    target: "coordinator", get activity() { return props.coordinatorActivity },
    get disabled() { return props.disabled || !props.active }, onAdmitted: () => props.onAdmitted() })
  const unregister = props.registerRetry?.({ pending: lifecycle.retryable, reconcile: async () => {}, resend: lifecycle.resend })
  onCleanup(() => unregister?.())
  // A running Mission whose coordinator is observed idle without a report (no
  // active descendants) offers recovery in Play's place. Unknown activity, e.g.
  // a large background subagent tree, keeps Pause: it is not evidence of idle.
  const stuck = () => props.coordinatorActivity === "idle-without-report"
  const primary = (): MissionPrimaryAction | undefined => {
    const current = lifecycle.primary(), recover = recovery.action()
    if (current?.key !== "pause" || !recover || !stuck()) return current
    return { key: "recover", label: t("missionsPanel.action.recover"), ariaLabel: t("missionsPanel.action.recover"),
      disabled: recover.disabled, onSelect: recover.onSelect }
  }
  // Waiting requests keep their exact identity: the button only shows the
  // state (full wording as tooltip) and never resends automatically.
  const requestLabel = () => !briefing.waiting() ? t("missionsPanel.action.requestUpdate")
    : t(briefing.state() === "uncertain" ? "missionsPanel.action.requestUpdateUncertain" : "missionsPanel.action.requestUpdatePending")
  const request = (): MissionPrimaryAction | undefined => briefing.available() ? {
    key: "briefing", label: requestLabel(),
    ariaLabel: briefing.waiting() ? t(`missions.briefing.request.${briefing.state()}`) : undefined,
    disabled: briefing.waiting() || props.messagingDisabled || !props.active, onSelect: () => briefing.ask() } : undefined
  return <MissionActionBar label={t("missionsPanel.picker.actions")} reading={props.reading} onToggleReader={props.onToggleReader}
    primary={primary()} stop={lifecycle.stop()} request={request()} onOpenConversation={() => props.onOpenCoordinator()}
    onEdit={() => props.onEdit()} onDelete={() => props.onDelete()} editDisabled={props.editDisabled} deleteDisabled={props.deleteDisabled}
    feedback={<>{lifecycle.feedback}{briefing.feedback(() => props.onOpenCoordinator())}{recovery.feedback}</>} />
}
