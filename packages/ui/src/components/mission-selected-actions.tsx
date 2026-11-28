import { Show, createSignal, onCleanup } from "solid-js"
import { MissionTaskActions, type MissionTaskSelection } from "./mission-task-actions"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionActorActivityState } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionActionBar } from "./mission-action-bar"
import { createMissionBriefingRequest } from "./mission-briefing"
import { createMissionLifecycle, type MissionControlRetry, type MissionPrimaryAction } from "./mission-lifecycle-controls"
import { createMissionRecoveryAction } from "./mission-recovery-button"
import { MissionBriefSave, type MissionBriefSaveTrigger } from "./mission-model-library"
import { missionRecordedBrief } from "../lib/mission-model-library"
import { missionDisplayTitle } from "../lib/mission-display"
import { useRecordedBriefInputs } from "./mission-target-bodies"
import { missionStore } from "../stores/missions"
import { showConfirmDialog } from "../stores/alerts"

/** Summary reader, lifecycle (with coordinator recovery on Play), update
 * request, coordinator conversation, edit and delete of the selected one-time
 * Mission. An unconfirmed lifecycle control is resent only through the panel's
 * explicit refresh, registered here. */
export function MissionSelectedActions(props: {
  instanceId: string; mission: MissionPanelMap; active: boolean; disabled: boolean; messagingDisabled: boolean
  reading: boolean; onToggleReader: () => void
  coordinatorActivity?: MissionActorActivityState; onOpenCoordinator: () => void; onAdmitted: () => Promise<void>
  /** Observed activity: some actor or its sub-agents still runs. */
  working?: boolean
  /** The Mission's mark is interrupted: its coordinator stopped without a report while nothing else runs. */
  interrupted: boolean
  onEdit: () => void; onDelete: () => void; editDisabled: boolean; deleteDisabled: boolean
  registerRetry?: (retry: MissionControlRetry) => () => void
  /** The selected task takes the toolbar; Summary then toggles its reader. */
   task?: MissionTaskSelection; taskPending?: boolean; taskReading?: boolean; onToggleTask?: () => void; onOpenTask?: (sessionId: string) => void
  /** Unfolds the selection's detail, where Save as brief opens its name field. */
  onRevealDetail?: () => void
  /** A programmed Mission's programming. A programmed Mission has one pause: Pause holds its launch under way and its programming,
   * and Play resumes both. Stop ends the launch under way; while none is (`between`), it ends the programming for good. */
  programming?: { paused: boolean; between: boolean; act(action: "pause" | "resume" | "delete"): Promise<void> }
}) {
  const { t } = useI18n()
  const lifecycle = createMissionLifecycle({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get disabled() { return props.disabled }, get working() { return props.working } })
  const briefing = createMissionBriefingRequest({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    get active() { return props.active }, get disabled() { return props.messagingDisabled } })
  const recovery = createMissionRecoveryAction({ get instanceId() { return props.instanceId }, get mission() { return props.mission },
    target: "coordinator", get activity() { return props.coordinatorActivity },
    get disabled() { return props.disabled || !props.active }, onAdmitted: () => props.onAdmitted() })
  // Its reconciliation reuses the panel's own mission map read and verifies the exact request.
  const unregister = props.registerRetry?.({ pending: lifecycle.retryable, reconcile: lifecycle.reconcile, resend: lifecycle.resend })
  onCleanup(() => unregister?.())
  // An interrupted Mission (coordinator observed idle without a report, nothing
  // else running) offers recovery in Pause's place, and a failed one offers it to
  // resume. Unknown activity, e.g. a large background subagent tree, keeps Pause:
  // it is not evidence of idle.
  const [programming, setProgramming] = createSignal(false)
  const program = async (action: "pause" | "resume" | "delete") => {
    setProgramming(true)
    try { await props.programming?.act(action) } finally { setProgramming(false) }
  }
  /** Pauses or resumes the programming alone: the toolbar's Play/Pause while no launch is under way. */
  const toggleProgramming = (): MissionPrimaryAction | undefined => {
    const value = props.programming
    if (!value) return undefined
    const key = value.paused ? "resume" : "pause", label = `${t("missions.scheduling.title")} · ${t(`missionsPanel.action.${key}`)}`
    return { key, label, ariaLabel: label, disabled: props.disabled, busy: programming(), onSelect: () => program(key) }
  }
  const stopProgramming = (): MissionPrimaryAction => ({ key: "stop", label: t("missions.scheduling.stop"), disabled: props.disabled, busy: programming(),
    onSelect: async () => {
      if (await showConfirmDialog(t("missions.scheduling.stopConfirm"), { variant: "warning", confirmLabel: t("missions.scheduling.stop"),
        cancelLabel: t("missions.control.cancel") })) await program("delete")
    } })
  const primary = (): MissionPrimaryAction | undefined => {
    if (props.programming?.between) return toggleProgramming()
    const launch = lifecycle.primary(), held = props.programming
    // Pausing a launch pauses the programmed Mission whole, and resuming it resumes the whole: the programming goes first into the pause and last out of it.
    const current: MissionPrimaryAction | undefined = !launch || !held || launch.key === "pause" && held.paused || launch.key === "resume" && !held.paused
      || launch.key !== "pause" && launch.key !== "resume" ? launch : { ...launch, onSelect: async () => {
        if (launch.key === "pause") await held.act("pause")
        await launch.onSelect()
        if (launch.key === "resume") await held.act("resume")
      } }
    const recover = recovery.action()
    const resumable = props.mission.status === "failed" ? !current : current?.key === "pause" && props.interrupted
    if (!recover || !resumable) return current
    return { key: "recover", label: t("missionsPanel.action.recover"), ariaLabel: t("missionsPanel.action.recover"),
      disabled: recover.disabled, onSelect: recover.onSelect }
  }
  // Waiting requests keep their exact identity: the button only shows the
  // state (full wording as tooltip) and never resends automatically.
  // Save as brief saves the recorded inputs of the one snapshot shown when its name field opens.
  const [briefOpen, setBriefOpen] = createSignal(false)
  // The overflow menu's Save as brief opens the name field shown in the detail.
  const [briefTrigger, setBriefTrigger] = createSignal<MissionBriefSaveTrigger>()
  const brief = useRecordedBriefInputs({ instanceId: () => props.instanceId, mission: () => props.mission, open: briefOpen,
    refresh: () => missionStore.refresh(props.instanceId) })
  const recordedBrief = () => {
    const inputs = brief.values()
    return inputs ? missionRecordedBrief(inputs.target, inputs) : missionRecordedBrief(props.mission, { objective: "", notes: "" })
  }
  const requestLabel = () => !briefing.waiting() ? t("missionsPanel.action.requestUpdate")
    : t(briefing.state() === "uncertain" ? "missionsPanel.action.requestUpdateUncertain" : "missionsPanel.action.requestUpdatePending")
  const request = (): MissionPrimaryAction | undefined => briefing.available() ? {
    key: "briefing", label: requestLabel(),
    ariaLabel: briefing.waiting() ? t(`missions.briefing.request.${briefing.state()}`) : undefined,
    disabled: briefing.waiting() || props.messagingDisabled || !props.active, onSelect: () => briefing.ask() } : undefined
  // The Mission's lifecycle state lives here, so it survives a task taking the toolbar.
  const feedback = <>{lifecycle.feedback}{briefing.feedback(() => props.onOpenCoordinator())}{recovery.feedback}</>
  return <Show when={props.task?.task.key} keyed fallback={
     <Show when={!props.taskPending} fallback={<MissionActionBar label={t("missionsPanel.picker.actions")} reading={false} feedback={feedback} />}><MissionActionBar label={t("missionsPanel.picker.actions")} reading={props.reading} onToggleReader={props.onToggleReader}
      primary={primary()} stop={props.programming?.between ? stopProgramming() : lifecycle.stop()}
      interrupt={lifecycle.interruptNow()} request={request()} onOpenConversation={() => props.onOpenCoordinator()}
      onEdit={() => props.onEdit()} onDelete={() => props.onDelete()} editDisabled={props.editDisabled} deleteDisabled={props.deleteDisabled}
      saveBrief={briefTrigger() && { disabled: briefTrigger()!.disabled, open: returnFocus => { props.onRevealDetail?.(); briefTrigger()!.open(returnFocus) } }}
       secondaryInDetail secondary={<MissionBriefSave instanceId={props.instanceId} disabled={props.disabled} active={() => props.active} trigger={trigger => setBriefTrigger(() => trigger)}
        draft={recordedBrief} initialName={() => missionDisplayTitle(props.mission, 80)} onOpen={setBriefOpen}
        reading={() => brief.state() === "ready" ? undefined
          : { failed: brief.state() === "failed", changed: brief.state() === "changed", onRetry: brief.retry }} />}
       feedback={feedback} /></Show>}>
    {_key => <MissionTaskActions instanceId={props.instanceId} mission={props.mission} selection={props.task!}
      disabled={props.disabled || !props.active} onAdmitted={props.onAdmitted} reading={Boolean(props.taskReading)} onToggleReader={() => props.onToggleTask?.()}
      onOpenConversation={id => props.onOpenTask?.(id)} feedback={feedback} />}
  </Show>
}
