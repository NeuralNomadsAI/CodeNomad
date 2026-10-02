import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChat } from "../stores/session-previews"
import { Markdown } from "./markdown"

export function MissionReader(props: { instanceId: string; scope: string }) {
  const { t } = useI18n()
  const target = () => missionProjectView(props.scope).reader
  const mission = () => missionStore.state(props.instanceId).missions.find(m => m.id === target()?.missionId)
  const task = () => mission()?.tasks.find(task => task.id === target()?.itemId)
  const report = () => mission()?.reports.find(report => report.id === target()?.itemId)
  const change = () => mission()?.history?.find(change => String(change.revision) === target()?.itemId)
  const title = () => target()?.kind === "task" ? task()?.title : target()?.kind === "report"
    ? mission()?.tasks.find(task => task.key === report()?.taskKey)?.title ?? report()?.taskKey
    : t(target()?.kind === "change" ? "missions.control.history.title" : "missions.control.overview")
  const sections = createMemo<Array<{ label: string; text: string; raw?: boolean }>>(() => {
    if (target()?.kind === "change") {
      const value = change()
      const taskName = (key: string) => mission()?.tasks.find(task => task.key === key)?.title ?? key
      const difference = (before: string, after: string) => `### ${t("missions.control.history.before")}\n\n${before || "—"}\n\n### ${t("missions.control.history.after")}\n\n${after || "—"}`
      return value ? [
        { label: "missions.control.summary", text: value.reason ?? t("missions.control.edit") },
        { label: "missions.control.objective", text: value.objective ? difference(value.objective.before, value.objective.after) : "" },
        { label: "missions.control.notes", text: value.notes ? difference(value.notes.before ?? "", value.notes.after ?? "") : "" },
        { label: "missions.control.route.title", text: value.addedTaskKeys.map(taskName).join("\n\n") },
        { label: "missions.control.task.status.superseded", text: value.retiredTasks.map(task => `${taskName(task.taskKey)}${task.replacementTaskKey ? ` → ${taskName(task.replacementTaskKey)}` : ""}`).join("\n\n") },
        { label: "missions.control.task.details", text: value.dependencyUpdates.map(task => `## ${taskName(task.taskKey)}\n\n${difference(task.before.map(taskName).join(", "), task.after.map(taskName).join(", "))}`).join("\n\n") },
      ] : []
    }
    if (target()?.kind === "task") return task() ? [{ label: "missions.control.brief", text: task()!.brief }] : []
    if (target()?.kind === "report") {
      const value = report()
      return value ? [
        { label: "missions.control.summary", text: value.summary },
        { label: "missions.control.report.evidence", text: value.evidence.join("\n\n") },
        { label: "missions.control.report.next", text: value.next.join("\n\n") },
        { label: "missions.control.artifact", text: value.artifact !== undefined ? JSON.stringify(value.artifact, null, 2) : "", raw: true },
      ] : []
    }
    const value = mission()
    return value ? [
      { label: "missions.control.objective", text: value.objective },
      { label: "missions.control.notes", text: value.notes ?? "" },
      { label: "missions.control.summary", text: value.summary ?? "" },
    ] : []
  })
  let body: HTMLDivElement | undefined
  let root: HTMLElement | undefined
  let closeButton: HTMLButtonElement | undefined
  let returnFocus: HTMLElement | undefined
  let previousTarget = ""
  createEffect(() => {
    const identity = JSON.stringify(target())
    if (identity !== previousTarget) { previousTarget = identity; if (body) body.scrollTop = 0 }
  })
  onMount(() => {
    void missionStore.ensure(props.instanceId)
    if (document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
    closeButton?.focus()
  })
  onCleanup(() => { if (root?.contains(document.activeElement) && returnFocus?.isConnected) returnFocus.focus() })
  const close = () => { showSessionChat(props.scope); updateMissionProjectView(props.scope, { reader: undefined }) }
  return <section ref={root} class="mission-reader window-shell" aria-label={t("missions.control.reports.title")}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close() } }}>
    <header class="window-header">
      <h2 class="window-title">{title()}</h2>
      <button ref={closeButton} type="button" class="window-icon-button" onClick={close}
        aria-label={t("missions.control.reader.close")} title={t("missions.control.reader.close")}>
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </header>
    <div class="window-body" ref={body}>
      <Show when={target()?.kind === "report" && report()?.late}><p>{t("missions.control.report.late")}</p></Show>
      <Show when={sections().length} fallback={<p>{t(missionStore.state(props.instanceId).status === "loading" ? "missions.control.loading" : "missions.control.reader.missing")}</p>}>
        <For each={sections().map(section => section.label)}>{label => {
          const section = () => sections().find(section => section.label === label)!
          return <Show when={section().text}><article><h3>{t(label)}</h3>
            <Show when={"raw" in section() && section().raw} fallback={<Markdown part={{ type: "text", text: section().text }} escapeRawHtml instanceId={props.instanceId} />}>
              <pre>{section().text}</pre>
            </Show>
          </article></Show>
        }}</For>
      </Show>
    </div>
  </section>
}
