import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { walkHistory } from "../stores/session-history"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"

export default function HistoryStatistics(props: { instanceId: string; sessionId?: string }) {
  const { t } = useI18n()
  const [refresh, setRefresh] = createSignal(0)
  const [counts, setCounts] = createSignal({ messages: 0, tools: 0, reasoning: 0, skipped: 0 })
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  createEffect(() => {
    const instanceId = props.instanceId
    const sessionID = props.sessionId
    getOpenCodeInstanceGeneration(instanceId)
    // Explicit snapshot: streaming events do not restart a whole-history scan.
    // Scope/connection changes and the refresh action request a new snapshot.
    refresh()
    const controller = new AbortController()
    setCounts({ messages: 0, tools: 0, reasoning: 0, skipped: 0 })
    setPending(true)
    setError("")
    void walkHistory(instanceId, { sessionID, query: "", purpose: "stats", includeTechnical: true }, page => {
      setCounts(previous => ({ messages: previous.messages + page.scanned, tools: previous.tools + page.tools,
        reasoning: previous.reasoning + page.reasoning, skipped: previous.skipped + page.skipped }))
    }, controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!controller.signal.aborted) setPending(false) })
    onCleanup(() => controller.abort())
  })
  return <div class="history-statistics" aria-live="polite">
    <span>{t("history.counts", counts())} · {pending() ? t("history.scanning") : t("history.snapshot")}</span>
    <button type="button" class="button-tertiary" onClick={() => setRefresh(n => n + 1)}>{t("messageSection.search.retry")}</button>
    <Show when={counts().skipped}><span>{t("history.skipped", { count: counts().skipped })}</span></Show>
    <Show when={error()}><span role="alert">{error()}</span></Show>
  </div>
}
