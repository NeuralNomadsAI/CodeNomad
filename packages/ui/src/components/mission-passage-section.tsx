import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { MissionRecurrenceCurrentContent } from "../../../server/src/api-types"
import type { RecurrenceCurrentContentInput } from "../../../server/src/missions/recurrence-current"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { missionMarkdownPage } from "../lib/mission-markdown-pages"
import { Markdown } from "./markdown"

export type MissionPassageSection = Omit<RecurrenceCurrentContentInput, "page"> & { projectID: string; missionID: string }
const cache = new Map<string, MissionRecurrenceCurrentContent>()

/** Exact isolated-journal page; never a transcript fetch or arbitrary mission selector. */
export function MissionPassageSectionContent(props: { instanceId: string; source: MissionPassageSection; page: number; raw?: boolean
  onPageCount: (count: number) => void }) {
  const { t } = useI18n()
  const [value, setValue] = createSignal<MissionRecurrenceCurrentContent>()
  const [error, setError] = createSignal(false)
  createEffect(() => {
    const source = props.source, page = props.page, instanceId = props.instanceId
    const directory = instances().get(instanceId)?.folder, client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const key = JSON.stringify([instanceId, directory, generation, source, page])
    const initial = cache.get(key)
    setValue(initial); setError(false)
    if (initial) props.onPageCount(initial.pageCount)
    const controller = new AbortController()
    let current = true
    const { projectID, missionID, ...input } = source
    void serverApi.fetchMissionCurrentContent(instanceId, { ...input, page }, controller.signal).then(result => {
      if (!current || controller.signal.aborted || instances().get(instanceId)?.folder !== directory
        || instances().get(instanceId)?.client !== client || getOpenCodeInstanceGeneration(instanceId) !== generation) return
      const parsed = result
      if (parsed.version !== 1 || parsed.projectID !== projectID || parsed.missionID !== missionID || parsed.scheduleID !== source.scheduleID
        || parsed.passageID !== source.passageID || parsed.revision !== source.revision || parsed.page !== page
        || !Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < 1 || parsed.pageCount > 64 || page >= parsed.pageCount
        || typeof parsed.sourceText !== "string" || parsed.sourceText.length > 9_001
        // The bounded Markdown-page projection (as for archived passages) is optional display context.
        || parsed.markdownText !== null && (typeof parsed.markdownText !== "string" || parsed.markdownText.length > 9_116)) throw new Error("Passage source changed")
      if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value!)
      cache.set(key, parsed); setValue(parsed); props.onPageCount(parsed.pageCount)
    }).catch(() => { if (current) setError(true) })
    onCleanup(() => { current = false; controller.abort() })
  })
  const markdown = () => {
    const result = value()
    // A sole bounded page is a complete document. Unknown split fences remain raw.
    return result?.pageCount === 1 && !props.raw ? missionMarkdownPage(result.sourceText, 0, 9_000).markdownText : null
  }
  return <>
    <Show when={error()}><p role="status">{t(value() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    <Show when={value()} fallback={<p role="status">{t("missions.control.loading")}</p>}>{result =>
      <Show when={markdown() !== null} fallback={<pre>{result().sourceText}</pre>}>
        <Markdown part={{ type: "text", text: markdown()! }} escapeRawHtml instanceId={props.instanceId} />
      </Show>
    }</Show>
  </>
}
