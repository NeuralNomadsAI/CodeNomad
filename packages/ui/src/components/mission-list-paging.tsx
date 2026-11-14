import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { useMissionPanelStore } from "./mission-panel-scope"
import { observeListEnd } from "../lib/list-end-observer"

/** One directory continuation, outside the task trees. Observations follow the
 * displayed rows automatically; only an unsuccessful observation needs Retry. */
export function MissionListPaging(props: {
  instanceId: string; active: boolean
  scheduleMore: boolean; scheduleLoading: boolean; scheduleError: boolean
  taskMarksError?: boolean; taskMarksLoading?: boolean; onTaskMarksRetry?: () => void
  onScheduleMore: () => void; onScheduleRetry: () => void
}) {
  const store = useMissionPanelStore(), { t } = useI18n()
  const summaries = () => store.progress(props.instanceId, "summaries")
  const marks = () => store.progress(props.instanceId, "marks")
  const failed = () => summaries().failure || marks().failure || props.scheduleError || props.taskMarksError
  const visible = () => summaries().more || props.scheduleMore || failed()
  const busy = () => !props.active || summaries().loading || props.scheduleLoading || Boolean(marks().failure && marks().loading) || props.taskMarksLoading
  const info = () => [summaries().more ? t("missionsPanel.pages.searchLoaded") : "",
    failed() ? t(summaries().failure === "changed" || marks().failure === "changed" ? "missionsPanel.pages.changed" : "missionsPanel.pages.failed") : "",
    marks().failure ? t("missionsPanel.pages.observations") : ""].filter(Boolean).join("\n")
  const load = (retryOnly = false) => {
    if (busy()) return
    if (props.taskMarksError) props.onTaskMarksRetry?.()
    if (props.scheduleError) props.onScheduleRetry()
    else if (!retryOnly && props.scheduleMore) props.onScheduleMore()
    for (const [lane, value] of [["summaries", summaries()], ["marks", marks()]] as const) {
      if (value.failure || !retryOnly && lane === "summaries" && value.more) void store.more(props.instanceId, lane, Boolean(value.failure))
    }
  }
  const [sentinel, setSentinel] = createSignal<HTMLDivElement>()
  createEffect(() => {
    const element = sentinel()
    if (!element || busy() || failed()) return
    onCleanup(observeListEnd(element, element.closest<HTMLElement>(".mission-control"), () => {
      if (!busy() && !failed()) load()
    }, 120))
  })
  return <Show when={visible()}><div ref={setSentinel} class="mission-list-paging">
    <Show when={failed()}>{_failed => {
    let button: HTMLButtonElement | undefined
    onCleanup(() => {
      const focused = document.activeElement === button, panel = button?.closest(".mission-control")
      if (focused) queueMicrotask(() => {
        if (document.activeElement === document.body) panel?.querySelector<HTMLInputElement>(".mission-picker-search")?.focus({ preventScroll: true })
      })
    })
    return <button ref={button} type="button" class="window-action"
        aria-disabled={busy()} title={info()} aria-description={info() || undefined} onClick={() => load(true)}>
        {t("missions.control.retry")}
      </button>
    }}</Show>
  </div></Show>
}
