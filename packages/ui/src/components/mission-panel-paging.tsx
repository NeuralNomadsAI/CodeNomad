import { Show } from "solid-js"
import { missionStore } from "../stores/missions"
import { useI18n } from "../lib/i18n"

/** Explicit continuation of exactly one directory, field or observation window. */
export function MissionPanelPaging(props: { instanceId: string; lane: string; search?: boolean }) {
  const { t } = useI18n(), state = () => missionStore.progress(props.instanceId, props.lane)
  const unknown = () => props.lane.startsWith("activity:") && missionStore.observations(props.instanceId, props.lane.slice(9)).some(page => page.coverage !== "observed" || page.requests.state !== "observed")
  return <Show when={state().total === undefined || state().more || state().failure || state().loading || unknown()}><div class="mission-panel-paging">
    <Show when={unknown()}><p role="status">{t("missionsPanel.pages.observations")}</p></Show>
    <Show when={state().total !== undefined}><p role="status">{t("missionsPanel.pages.coverage", { loaded: state().loaded, total: state().total! })}</p></Show>
    <Show when={props.search && state().more}><p>{t("missionsPanel.pages.searchLoaded")}</p></Show>
    <Show when={state().failure}><p role="status">{t(state().failure === "changed" ? "missionsPanel.pages.changed" : "missionsPanel.pages.failed")}</p>
      <button type="button" class="window-text-button" disabled={state().loading} onClick={() => void missionStore.more(props.instanceId, props.lane, true)}>{t("missions.control.retry")}</button>
    </Show>
    <Show when={!state().failure && (state().more || state().total === undefined)}>
      <button type="button" class="window-text-button" disabled={state().loading} onClick={() => void missionStore.more(props.instanceId, props.lane)}>
        {t(state().loading ? "missions.control.loading" : "missionsPanel.pages.more")}</button>
    </Show>
  </div></Show>
}
