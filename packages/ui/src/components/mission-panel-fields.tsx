import { For, Show, createMemo, createSignal } from "solid-js"
import { BoundedText } from "./hidden-text"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { useMissionPanelStore } from "./mission-panel-scope"
import { useI18n } from "../lib/i18n"
import { MissionPanelPaging } from "./mission-panel-paging"
import { createMissionDisclosure } from "./mission-disclosure"

function Value(props: { value: unknown }) {
  const text = createMemo(() => JSON.stringify(props.value))
  return <BoundedText source={text()}>{shown => <pre>{shown()}</pre>}</BoundedText>
}

function Field(props: { instanceId: string; missionId: string; field: string }) {
  const missionStore = useMissionPanelStore()
  const { t } = useI18n(), [raw, setRaw] = createSignal(false), [page, setPage] = createSignal(0)
  const lane = () => `text:${props.missionId}:${props.field}`, state = () => missionStore.progress(props.instanceId, lane())
  const read = async (at: number, retry = false) => {
    setPage(at)
    await missionStore.more(props.instanceId, lane(), retry, at)
  }
  return <>
    <button type="button" class="window-action" aria-pressed={raw()} onClick={() => {
      setRaw(value => !value)
      if (raw() && state().total === undefined) void read(0)
    }}>{t("missionsPanel.pages.raw")}</button>
    <Show when={raw()} fallback={<>
      <MissionPanelPaging instanceId={props.instanceId} lane={`field:${props.missionId}:${props.field}`} />
      <For each={missionStore.fieldValues(props.instanceId, props.missionId, props.field)}>{value => <Value value={value} />}</For>
    </>}>
      <Show when={state().failure}><p role="status">{t(state().failure === "changed" ? "missionsPanel.pages.changed" : "missionsPanel.pages.failed")}</p>
        <button type="button" class="window-action" disabled={state().loading} onClick={() => void read(state().failure === "changed" ? 0 : page(), true)}>{t("missions.control.retry")}</button>
      </Show>
      <p role="status">{t(state().loading ? "missions.control.loading" : "missionsPanel.pages.rawPage", { page: page() + 1, total: state().total ?? 0 })}</p>
      <button type="button" class="window-action" disabled={state().loading || Boolean(state().failure) || page() === 0} onClick={() => void read(page() - 1)}>{t("missionsPanel.pages.previous")}</button>
      <button type="button" class="window-action" disabled={state().loading || Boolean(state().failure) || page() + 1 >= (state().total ?? 0)} onClick={() => void read(page() + 1)}>{t("missionsPanel.pages.next")}</button>
      <Show when={missionStore.fieldText(props.instanceId, props.missionId, props.field, page())}>{text => <BoundedText source={text()}>{shown => <pre>{shown()}</pre>}</BoundedText>}</Show>
    </Show>
  </>
}

/** Exact persisted fields, including wide extension/document metadata, are explicitly
 * readable without widening the selected header or implying an unscanned absence. */
export function MissionPanelFields(props: { instanceId: string; mission: MissionPanelMap }) {
  const missionStore = useMissionPanelStore()
  const { t } = useI18n()
  const [open, setOpen] = createMissionDisclosure(() => props.instanceId, () => props.mission.id, () => "overview:fields")
  const fields = createMemo(() => new Map([...Object.entries(props.mission.panelCollections ?? {}).filter(([key]) => key !== "tasks").map(([field, descriptor]) => [field, descriptor.total] as const),
    ...(props.mission.panelControl ? [["control:receipts", props.mission.panelControl.receipts], ["control:pending", props.mission.panelControl.pending]] as Array<[string, number]> : [])]))
  return <Show when={props.mission.panelCollections}><details class="mission-panel-fields" open={open()} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("missionsPanel.pages.fields")}</summary>
    <For each={[...fields().keys()]}>
      {field => {
        const [fieldOpen, setFieldOpen] = createMissionDisclosure(() => props.instanceId, () => props.mission.id, () => `field:${field}`)
        return <details open={fieldOpen()} onToggle={event => {
          setFieldOpen(event.currentTarget.open)
          if (event.currentTarget.open && missionStore.progress(props.instanceId, `field:${props.mission.id}:${field}`).total === undefined)
            void missionStore.more(props.instanceId, `field:${props.mission.id}:${field}`)
        }}><summary><bdi>{field.replace(":", ".")}</bdi> ({fields().get(field)})</summary>
          <Field instanceId={props.instanceId} missionId={props.mission.id} field={field} />
        </details>}}
    </For>
  </details></Show>
}
