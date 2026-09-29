import { For, Show } from "solid-js"
import { History } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionReadButton } from "./mission-read-button"

export function MissionHistory(props: { mission: MissionMap; onRead: (revision: number) => void }) {
  const { t, locale } = useI18n()
  const history = () => props.mission.history ?? []
  return <MissionDisclosure missionId={props.mission.id} name="history" defaultOpen={false}
    title={<><History class="h-4 w-4" aria-hidden="true" /><span>{t("missions.control.history.title")}</span></>}>
    <Show when={history().length} fallback={<p class="mission-control-empty-line">{t("missions.control.history.empty")}</p>}>
      <Show when={props.mission.historyTruncated}><p>{t("missions.control.history.truncated", { count: history().length })}</p></Show>
      <ol class="mission-history-list"><For each={history().map(change => change.revision).reverse()}>{revision => {
        const change = () => history().find(change => change.revision === revision)!
        return <li>
          <div class="mission-history-copy"><div class="mission-route-meta"><time dateTime={new Date(change().createdAt).toISOString()}>{new Date(change().createdAt).toLocaleString(locale())}</time>
            <span>{change().source === "user" ? t("missions.control.history.user") : change().actorSessionId === props.mission.coordinatorSessionId
              ? t("missions.control.history.coordinator")
              : props.mission.actors.find(actor => actor.sessionId === change().actorSessionId)?.title ?? change().actorSessionId}</span>
          </div>
          <p class="mission-text-excerpt">{change().reason ?? t("missions.control.edit")}</p></div>
          <MissionReadButton onClick={() => props.onRead(revision)} />
        </li>
      }}</For></ol>
    </Show>
  </MissionDisclosure>
}
