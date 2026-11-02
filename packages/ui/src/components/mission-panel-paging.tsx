import { Show, createMemo } from "solid-js"
import { missionStore } from "../stores/missions"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"

/** Explicit continuation of exactly one directory, field or observation window. */
export function MissionPanelPaging(props: { instanceId: string; lane: string; search?: boolean }) {
  const { t } = useI18n(), state = () => missionStore.progress(props.instanceId, props.lane)
  const unknown = () => props.lane.startsWith("activity:") && missionStore.observations(props.instanceId, props.lane.slice(9)).some(page => page.coverage !== "observed" || page.requests.state !== "observed")
  // Once a lane needs a continuation/info row, retain its slot through subsequent
  // refresh cycles. Only actual read results, never loading, introduce the row.
  const visible = createMemo<{ key: string; shown: boolean }>(previous => {
    const key = JSON.stringify([props.instanceId, props.lane])
    return { key, shown: Boolean(state().more || state().failure || unknown() || previous?.key === key && previous.shown) }
  })
  const info = () => [
    state().total !== undefined ? t("missionsPanel.pages.coverage", { loaded: state().loaded, total: state().total! }) : "",
    props.search && state().more ? t("missionsPanel.pages.searchLoaded") : "",
    unknown() || props.lane === "marks" ? t("missionsPanel.pages.observations") : "",
  ].filter(Boolean).join(" ")
  return <Show when={visible().shown}><div class="mission-panel-paging" data-lane={props.lane}>
    <Show when={info()}>{text => <SettingsInfoTip text={text()} />}</Show>
    <Show when={state().failure}><p role="status">{t(state().failure === "changed" ? "missionsPanel.pages.changed" : "missionsPanel.pages.failed")}</p>
      <button type="button" class="window-text-button" disabled={state().loading} onClick={() => void missionStore.more(props.instanceId, props.lane, true)}>{t("missions.control.retry")}</button>
    </Show>
    <Show when={!state().failure && state().more}>
      <button type="button" class="window-text-button" disabled={state().loading} onClick={() => void missionStore.more(props.instanceId, props.lane)}>
        {t("missionsPanel.pages.more")}</button>
    </Show>
  </div></Show>
}
