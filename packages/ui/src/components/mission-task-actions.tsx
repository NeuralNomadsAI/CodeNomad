import type { JSX } from "solid-js"
import type { MissionActorActivity, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionActionBar } from "./mission-action-bar"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"
import { createMissionRecoveryAction } from "./mission-recovery-button"

/** A task whose reader is open: the header toolbar acts on it. */
export interface MissionTaskSelection {
  task: MissionPanelTask
  /** The task's exact owned conversation, once one is known. */
  conversation?: string
  activity?: MissionActorActivity["state"]
}

/** The header toolbar while a task's reader is open: the primary action asks the
 * task's actor for its report again when that recovery applies, Summary closes the
 * task's reader, and Open conversation reaches the task's own conversation. The
 * Mission's own lifecycle, delete and overflow actions stay in place, disabled. */
export function MissionTaskActions(props: {
  instanceId: string; mission: MissionPanelMap; selection: MissionTaskSelection; disabled: boolean
  onAdmitted: () => Promise<void>; onCloseReader: () => void; onOpenConversation: (sessionId: string) => void
  feedback?: JSX.Element
}) {
  const { t } = useI18n()
  const recovery = createMissionRecoveryAction({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    target: "report", taskKey: props.selection.task.key, get activity() { return props.selection.activity },
    get disabled() { return props.disabled }, onAdmitted: () => props.onAdmitted() })
  const primary = (): MissionPrimaryAction | undefined => {
    const action = recovery.action()
    return action ? { key: "check", label: action.label, ariaLabel: action.description ? `${action.label} — ${action.description}` : action.label,
      disabled: action.disabled, onSelect: action.onSelect } : undefined
  }
  const conversation = () => props.selection.conversation
  return <MissionActionBar label={t("missionsPanel.picker.actions")} reading onToggleReader={() => props.onCloseReader()}
    primary={primary()} openLabel={t("missionsPanel.task.openConversation")}
    onOpenConversation={conversation() ? () => props.onOpenConversation(conversation()!) : undefined}
    feedback={<>{props.feedback}{recovery.feedback}</>} />
}
