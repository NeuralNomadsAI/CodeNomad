import { For, Show, createMemo } from "solid-js"
import { ArrowUpRight, Eye, GitBranch } from "lucide-solid"
import type { MissionMap, MissionTask, MissionReport, MissionActorActivity } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionGraph, orderMissionTasks } from "./mission-graph"
import { MissionListItem } from "./mission-list-item"
import { createMissionRecoveryAction } from "./mission-recovery-button"
import { missionTaskStatusKey } from "./mission-native-execution-model"
import { missionTaskConversation } from "./mission-task-navigation"
import type { MissionObservedFamily } from "./mission-attention-model"
import { missionProgress } from "./mission-progress-model"

export function MissionWork(props: {
  mission: MissionMap; instanceId: string; activeSessionId: string | null
  onOpenActor: (id: string) => Promise<void>
  onRead: (task: MissionTask) => void; onReport: (report: MissionReport) => void
  reading?: (task: MissionTask) => boolean
  activity?: MissionActorActivity[]; disabled?: boolean
  family?: MissionObservedFamily
  onRecoveryAdmitted?: () => void | Promise<void>
}) {
  const { t } = useI18n()
  let list!: HTMLUListElement
  const ordered = createMemo(() => orderMissionTasks(props.mission.tasks))
  const progress = createMemo(() => missionProgress(props.mission, props.activity))
  // Opt-in dependency view inside More; the card's checklist is the default task list.
  return <MissionDisclosure missionId={props.mission.id} name="route" defaultOpen={false} label={t("missionsPanel.dependencies")}
    title={<><GitBranch class="h-4 w-4" aria-hidden="true" /><span>{t("missionsPanel.dependencies")}</span>
      <small title={t("missions.control.metrics.tasks")}>{progress().completed}/{progress().tasks.length}</small></>}>
    <Show when={props.mission.tasks.length} fallback={<p class="mission-control-empty-line">{t("missions.control.route.empty")}</p>}>
      <div class="mission-flow">
        <ul ref={list} class="mission-route-list"><For each={ordered().map(task => task.id)}>{id => {
          const task = () => props.mission.tasks.find(task => task.id === id)!
          const recovery = createMissionRecoveryAction({
            get instanceId() { return props.instanceId },
            get mission() { return props.mission },
            target: "report",
            get taskKey() { return task().key },
            get disabled() { return props.disabled },
            get activity() { return props.activity?.find(value => value.sessionId === task().actorSessionId)?.state },
            onAdmitted: () => props.onRecoveryAdmitted?.(),
          })
          const actions = (): ActionOverflowMenuItem[] => {
            const recover = props.onRecoveryAdmitted ? recovery.action() : undefined
            const sessionId = missionTaskConversation(props.mission, task(), props.family)
            return [...(sessionId ? [{ key: "actor", label: t("missions.control.attention.openActor", { actor: props.mission.actors.find(actor => actor.sessionId === sessionId)?.title ?? sessionId }),
              icon: <ArrowUpRight class="h-4 w-4" />, onSelect: () => {
                const current = missionTaskConversation(props.mission, task(), props.family)
                if (current) return props.onOpenActor(current)
              } }] : []),
              { key: "read", label: t("missions.control.read"), checked: props.reading?.(task()) ?? false, icon: <Eye class="h-4 w-4" />,
              onSelect: () => props.onRead(task()) }, ...(recover ? [recover] : [])]
          }
          return <li class="mission-route-task" data-task-key={task().key} data-status={task().status}
            data-archived={task().status === "withdrawn" || Boolean(task().replacedByTaskKey) ? "true" : undefined}>
            <MissionListItem compact text={<h3 class="mission-task-title" title={task().title}>{task().title}</h3>}
              onSelect={() => props.onRead(task())}
              title={task().title} status={<span title={t(task().status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(task()))}
                aria-label={t(task().status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(task()))}>
                {t(task().status === "needs-input" ? "missions.control.report.outcome.blocked" : missionTaskStatusKey(task()))}
              </span>} statusKind={task().status === "needs-input" ? "blocked" : task().status} actions={actions()}
              children={props.onRecoveryAdmitted && recovery.action()?.description ? recovery.feedback : undefined} />
          </li>
        }}</For></ul>
        <MissionGraph tasks={ordered()} list={list} />
      </div>
    </Show>
  </MissionDisclosure>
}
