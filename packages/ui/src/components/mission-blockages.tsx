import { For, Show, createMemo } from "solid-js"
import { AlertTriangle, ArrowUpRight, Eye } from "lucide-solid"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { selectMissionBlockages } from "./mission-attention-model"

/** A returned blocker needs coordinator follow-up, not a fabricated reply form. */
export function MissionBlockages(props: {
  mission: MissionMap
  onRead: (task: MissionTask) => void
  onOpenActor: (sessionId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const items = createMemo(() => selectMissionBlockages(props.mission.tasks))
  return <Show when={props.mission.status === "active" && items().length}>
    <MissionDisclosure missionId={props.mission.id} name="blockages"
      title={<><AlertTriangle class="h-4 w-4" aria-hidden="true" /><span>{t("missions.control.blockages.title")}</span></>}>
      <p class="mission-control-empty-line">{t("missions.control.blockages.hint")}</p>
      <ul class="mission-attention-list"><For each={items().map(item => item.taskKey!)}>{key => {
        const task = () => props.mission.tasks.find(task => task.key === key)!
        return <li><MissionListItem text={<><strong>{task().title}</strong>{" — "}{task().report?.summary}</>}
          status={t("missions.control.attention.blocked")} statusKind="blocked"
          actions={[
            { key: "read", label: t("missions.control.read"), icon: <Eye class="h-4 w-4" />, onSelect: () => props.onRead(task()) },
            { key: "coordinator", label: t("missions.control.openCoordinator"), icon: <ArrowUpRight class="h-4 w-4" />,
              onSelect: () => props.onOpenActor(props.mission.coordinatorSessionId) },
          ]} /></li>
      }}</For></ul>
    </MissionDisclosure>
  </Show>
}
