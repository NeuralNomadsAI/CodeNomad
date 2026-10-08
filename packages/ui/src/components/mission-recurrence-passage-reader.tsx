import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionRecurrenceReadPage } from "../../../server/src/api-types"
import type { RecurrenceHistoryItem } from "../stores/mission-recurrence"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { MissionReaderSection } from "./mission-reader"
import { MissionReaderNumber } from "./mission-reader-number"

const cache = new Map<string, { value: MissionRecurrenceReadPage; client: unknown; generation: number }>()
const labels: Record<MissionRecurrenceReadPage["sections"][number]["label"], string> = {
  summary: "missions.control.summary", objective: "missions.control.objective", notes: "missions.control.notes",
  evidence: "missions.control.report.evidence", next: "missions.control.report.next", brief: "missions.control.brief",
  artifact: "missions.control.artifact", achieved: "missions.briefing.achieved", ongoing: "missions.briefing.ongoing", obstacles: "missions.briefing.obstacles",
}

/** Only mounted visible readers demand a bounded journal page; references remain in the parent on failure. */
export function MissionRecurrencePassageReader(props: { instanceId: string; scope: string; projectID: string; scheduleID: string; receipt: RecurrenceHistoryItem }) {
  const { t } = useI18n()
  const [selection, setSelection] = createSignal({ identity: "", section: 0, page: 0 }), [refresh, setRefresh] = createSignal(0)
  const [value, setValue] = createSignal<MissionRecurrenceReadPage>(), [error, setError] = createSignal(false), [loading, setLoading] = createSignal(false)
  const binding = createMemo(() => JSON.stringify([props.instanceId, props.scope, props.projectID, props.scheduleID, props.receipt]))
  const section = () => selection().identity === binding() ? selection().section : 0
  const page = () => selection().identity === binding() ? selection().page : 0
  const selectSection = (section: number) => setSelection({ identity: binding(), section, page: 0 })
  const selectPage = (page: number) => setSelection({ identity: binding(), section: section(), page })
  const connection = createMemo(() => ({ instanceId: props.instanceId, client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.instanceId === b.instanceId && a.client === b.client && a.generation === b.generation) })
  let previous = ""
  let previousClient: unknown, previousGeneration: number | undefined
  let previousRefresh = 0
  createEffect(() => {
    const revalidate = refresh()
    const retry = revalidate !== previousRefresh
    previousRefresh = revalidate
    const identity = binding(), { instanceId, scope, projectID, scheduleID, receipt } = untrack(() => ({
      instanceId: props.instanceId, scope: props.scope, projectID: props.projectID, scheduleID: props.scheduleID, receipt: props.receipt,
    })), selectedSection = section(), selectedPage = page()
    const { client, generation } = connection()
    const key = JSON.stringify([identity, selectedSection, selectedPage]), entry = cache.get(key)
    const cached = entry?.client === client && entry?.generation === generation ? entry.value : undefined
    const sameSource = previous === identity && previousClient === client && previousGeneration === generation
    const revision = sameSource ? untrack(value)?.revision : undefined
    previous = identity
    previousClient = client; previousGeneration = generation
    setValue(cached ?? (sameSource ? untrack(value) : undefined)); setError(false); setLoading(!cached)
    // Exact archived receipts are immutable. Reopening a known page is demand
    // for cached prose, not another journal read; connection fences revoke it.
    if (cached && !retry) return
    const controller = new AbortController()
    let current = true
    const admitted = () => current && !controller.signal.aborted && binding() === identity
      && instances().get(instanceId)?.folder === scope && instances().get(instanceId)?.metadata?.project?.id === projectID
      && instances().get(instanceId)?.client === client && getOpenCodeInstanceGeneration(instanceId) === generation
    void serverApi.fetchMissionRecurrencePassagePage(instanceId, scheduleID, receipt.passageID,
      { section: selectedSection, page: selectedPage, ...(revision === undefined ? {} : { revision }) }, controller.signal).then(result => {
      if (!admitted()) return
      if (result.version !== 1 || result.projectID !== projectID || result.scheduleID !== scheduleID || result.passageID !== receipt.passageID
        || result.missionID !== receipt.missionID || result.conversationID !== receipt.conversationID
        || result.section !== selectedSection || result.page !== selectedPage || revision !== undefined && result.revision !== revision
        || !Array.isArray(result.sections) || result.sections.length > 32 || !result.sections.some(item => item.index === selectedSection)
        || result.sourceText.length > 9001 || result.markdownText !== null && result.markdownText.length > 9116) throw new Error("Foreign archived page")
      if (cache.size >= 64 && !cache.has(key)) cache.delete(cache.keys().next().value!)
      cache.set(key, { value: result, client, generation }); setValue(result)
    }).catch(() => { if (admitted()) setError(true) }).finally(() => { if (current) setLoading(false) })
    onCleanup(() => { current = false; controller.abort() })
  })
  const selected = () => value()?.sections.find(item => item.index === value()?.section)
  return <section class="mission-recurrence-result" aria-label={t("missions.recurrence.readResult", { id: props.receipt.passageID })}>
    <Show when={loading()}><p role="status">{t("missions.control.loading")}</p></Show>
    <Show when={error()}><p role="alert">{t("missions.recurrence.resultUnavailable")}</p>
      <button type="button" class="window-text-button" onClick={() => setRefresh(value => value + 1)}>{t("missions.control.refresh")}</button>
    </Show>
    <Show when={value()}>{result => <>
      <div class="window-toolbar">
        <label>{t("missions.recurrence.section", { section: result().section + 1, total: result().sectionCount })}
          <MissionReaderNumber value={result().section + 1} max={result().sectionCount} identity={binding()}
            label={t("missions.recurrence.section", { section: result().section + 1, total: result().sectionCount })}
            onCommit={next => selectSection(next - 1)} />
        </label>
        <select aria-label={t("missions.recurrence.section", { section: result().section + 1, total: result().sectionCount })}
          value={result().section} onChange={event => selectSection(Number(event.currentTarget.value))}>
          <For each={result().sections}>{item => <option value={item.index}>{item.title ? `${item.title} — ` : ""}{t(labels[item.label])}</option>}</For>
        </select>
      </div>
      <Show when={selected()}>{item => <>
        <Show when={item().title}><h3>{item().title}</h3></Show>
        <MissionReaderSection instanceId={props.instanceId} identity={binding()} label={labels[item().label]} raw={item().raw}
          text={result().sourceText} pagination={{ page: result().page, pageCount: result().pageCount,
            content: { sourceText: result().sourceText, markdownText: result().markdownText }, onPage: selectPage }} />
      </>}</Show>
    </>}</Show>
  </section>
}
