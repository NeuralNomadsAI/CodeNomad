import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChat } from "../stores/session-previews"
import { Markdown } from "./markdown"
import { copyToClipboard } from "../lib/clipboard"
import { MissionTaskReader } from "./mission-task-reader"
import { MissionReportNotification } from "./mission-native-execution"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { activeSessionId, activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { sessionPreviews } from "../stores/session-previews"
import { missionIncludesSession } from "./mission-attention-model"
import { missionTaskConversation } from "./mission-task-navigation"

// One bounded page per section, including raw artifacts. Leave shared Markdown/tool budgets alone.
const READER_PAGE_SIZE = 9_000
export function MissionReaderSection(props: { text: string; raw?: boolean; identity: string; instanceId: string; label: string }) {
  const { t } = useI18n()
  const [page, setPage] = createSignal(0)
  const [copyStatus, setCopyStatus] = createSignal("")
  const pageCount = () => Math.max(1, Math.ceil(props.text.length / READER_PAGE_SIZE))
  let article: HTMLElement | undefined
  const captureCopy = createMissionViewFence(() => JSON.stringify([props.instanceId, props.identity, props.text]), () => true)
  let previousIdentity: string | undefined
  let previousText: string | undefined
  createEffect(() => {
    const identity = props.identity, text = props.text
    if (identity === previousIdentity && text === previousText) return
    previousIdentity = identity; previousText = text
    setPage(0); setCopyStatus("")
  })
  const pageText = createMemo(() => {
    // Keep surrogate pairs together without dropping source characters between pages.
    const boundary = (offset: number) => offset > 0 && /[\uDC00-\uDFFF]/.test(props.text.charAt(offset))
      && /[\uD800-\uDBFF]/.test(props.text.charAt(offset - 1)) ? offset - 1 : offset
    return props.text.slice(boundary(page() * READER_PAGE_SIZE), boundary((page() + 1) * READER_PAGE_SIZE))
  })
  const copy = async () => {
    const current = captureCopy(), text = props.text
    const success = await copyToClipboard(text)
    if (current())
      setCopyStatus(t(success ? "markdown.codeBlock.copy.copied" : "markdown.codeBlock.copy.failed"))
  }
  return <article ref={article}>
    <h3>{t(props.label)}</h3>
    <Show when={pageCount() > 1}>
      <div class="window-toolbar">
        <label class="window-actions">
          <span>{t("toolCall.permission.diff.page", { page: page() + 1, total: pageCount() })}</span>
          <input type="number" class="w-16" min="1" max={pageCount()} value={page() + 1}
            aria-label={t("toolCall.permission.diff.page", { page: page() + 1, total: pageCount() })}
            onInput={event => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isInteger(next) && next >= 1 && next <= pageCount()) {
                setPage(next - 1)
                article?.scrollIntoView({ block: "nearest" })
              }
            }} />
        </label>
        <button type="button" class="window-text-button" onClick={() => void copy()}>{t("markdown.copy")}</button>
        <span role="status">{copyStatus()}</span>
      </div>
    </Show>
    <Show when={props.raw} fallback={<Markdown part={{ type: "text", text: pageText() }} escapeRawHtml instanceId={props.instanceId} />}>
      <pre>{pageText()}</pre>
    </Show>
  </article>
}

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
  const [navigationError, setNavigationError] = createSignal(false)
  const captureNavigation = createMissionViewFence(() => JSON.stringify([
    props.instanceId, props.scope, target(), instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id, missionStore.state(props.instanceId).projectID,
    activeSessionId().get(props.instanceId), activeParentSessionId().get(props.instanceId), sessionPreviews().get(props.scope),
  ]), () => Boolean(target()))
  let navigationIntent = 0
  const openActor = async (sessionId: string) => {
    const current = captureNavigation(), intent = ++navigationIntent
    const instanceId = props.instanceId, scope = props.scope
    const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const authorized = () => {
      const value = mission()
      const currentTask = task()
      if (!value || target()?.kind !== "task" || !currentTask) return false
      const family = missionStore.state(instanceId).activity?.missions.find(item => item.missionId === value.id)?.family
      return missionTaskConversation(value, currentTask, family) === sessionId
        && (value.coordinatorSessionId === sessionId || missionIncludesSession(value.actors, sessionId, family))
    }
    const admitted = () => current() && intent === navigationIntent && authorized()
      && instances().get(instanceId)?.client === client && getOpenCodeInstanceGeneration(instanceId) === generation
      && !getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)
    if (!admitted()) return
    setNavigationError(false)
    // Native session.get resolves the owned location; the catalog reads only
    // agents/models/commands. Hydrate this ID and its parents, never list all sessions.
    try { await hydrateRestoredSessionChain(instanceId, [sessionId], undefined, admitted) }
    catch { if (admitted()) setNavigationError(true); return }
    if (!admitted()) return
    if (!sessions().get(instanceId)?.has(sessionId)) { setNavigationError(true); return }
    batch(() => {
      setActiveSessionFromList(instanceId, sessionId)
      showSessionChat(scope)
      updateMissionProjectView(scope, { reader: undefined })
    })
  }
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
    if (target()?.kind === "task") return []
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
  let disposed = false
  createEffect(() => {
    const identity = JSON.stringify([props.instanceId, props.scope, target()])
    if (identity !== previousTarget) {
      previousTarget = identity
      setNavigationError(false)
      if (body) {
        body.scrollTop = 0
        queueMicrotask(() => { if (!disposed && previousTarget === identity) closeButton?.focus() })
      }
    }
  })
  onMount(() => {
    void missionStore.ensure(props.instanceId)
    if (document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
    closeButton?.focus()
  })
  onCleanup(() => { disposed = true; if (root?.contains(document.activeElement) && returnFocus?.isConnected) returnFocus.focus() })
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
      <Show when={navigationError()}><p role="alert">{t("sessionList.reload.error")}</p></Show>
      <Show when={target()?.kind === "report" && report()?.late}><p>{t("missions.control.report.late")}</p></Show>
      <Show when={target()?.kind === "report" && report()}>{value => <MissionReportNotification report={value()} />}</Show>
      <Show when={target()?.kind === "task" && task() && mission()} fallback={
        <Show when={sections().length} fallback={<p>{t(missionStore.state(props.instanceId).status === "loading" ? "missions.control.loading" : "missions.control.reader.missing")}</p>}>
        <For each={sections().map(section => section.label)}>{label => {
          const section = () => sections().find(section => section.label === label)!
          return <Show when={section().text}><MissionReaderSection label={label} text={section().text}
            raw={section().raw} identity={JSON.stringify([props.instanceId, props.scope, target()])} instanceId={props.instanceId} /></Show>
        }}</For>
        </Show>
      }>
        <MissionTaskReader instanceId={props.instanceId} scope={props.scope} mission={mission()!} task={task()!}
          identity={JSON.stringify([props.instanceId, props.scope, target()])} onOpenActor={openActor}
          family={missionStore.state(props.instanceId).activity?.missions.find(item => item.missionId === mission()?.id)?.family}
          activity={missionStore.state(props.instanceId).activity?.missions.find(item => item.missionId === mission()?.id)?.actors.find(actor => actor.sessionId === task()?.actorSessionId)?.state} />
      </Show>
    </div>
  </section>
}
