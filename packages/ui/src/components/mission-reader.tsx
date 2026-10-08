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
import { missionReports, missionReportIsPrevious, missionTaskReport, missionProgress } from "./mission-progress-model"
import { missionMarkdownPage } from "../lib/mission-markdown-pages"
import { missionBriefingFreshness } from "./mission-briefing-model"
import { useMissionCurrentPassage } from "../stores/mission-recurrence"
import { MissionPassageSectionContent, type MissionPassageSection } from "./mission-passage-section"

import { useMissionRecurrence } from "../stores/mission-recurrence"
import { MissionRecurrencePassageReader } from "./mission-recurrence-passage-reader"
import type { MissionMarkdownPage } from "../lib/mission-markdown-pages"
import { MissionReaderNumber } from "./mission-reader-number"

// One bounded page per section, including raw artifacts. Leave shared Markdown/tool budgets alone.
const READER_PAGE_SIZE = 9_000
export function MissionReaderSection(props: { text: string; raw?: boolean; identity: string; instanceId: string; label: string; source?: MissionPassageSection;
  pagination?: { page: number; pageCount: number; content: MissionMarkdownPage; onPage: (page: number) => void } }) {
  const { t } = useI18n()
  const [page, setPage] = createSignal(0)
  const [copyStatus, setCopyStatus] = createSignal("")
  const [remoteCount, setRemoteCount] = createSignal<number>()
  const currentPage = () => props.pagination?.page ?? page()
  const pageCount = () => props.pagination?.pageCount ?? remoteCount() ?? Math.max(1, Math.ceil(props.text.length / READER_PAGE_SIZE))
  let article: HTMLElement | undefined
  const captureCopy = createMissionViewFence(() => JSON.stringify([props.instanceId, props.identity, props.text]), () => true)
  let previousIdentity: string | undefined
  let previousText: string | undefined
  createEffect(() => {
    const identity = props.identity, text = props.text
    if (identity === previousIdentity && text === previousText) return
    previousIdentity = identity; previousText = text
    setPage(0); setCopyStatus(""); setRemoteCount(undefined)
  })
  const content = createMemo(() => props.pagination?.content ?? missionMarkdownPage(props.text, page(), READER_PAGE_SIZE))
  const copy = async () => {
    const current = captureCopy(), text = props.text
    const success = await copyToClipboard(text)
    if (current())
      setCopyStatus(t(success ? "markdown.codeBlock.copy.copied" : "markdown.codeBlock.copy.failed"))
  }
  return <article ref={article}>
    <h3>{t(props.label)}</h3>
    <Show when={pageCount() > 1 || props.pagination || props.source}>
      <div class="window-toolbar">
        <label class="window-actions">
          <span>{t("toolCall.permission.diff.page", { page: currentPage() + 1, total: pageCount() })}</span>
          <Show when={props.pagination || props.source} fallback={<input type="number" class="w-16" min="1" max={pageCount()} value={page() + 1}
            aria-label={t("toolCall.permission.diff.page", { page: page() + 1, total: pageCount() })}
            onInput={event => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isInteger(next) && next >= 1 && next <= pageCount()) { setPage(next - 1); article?.scrollIntoView({ block: "nearest" }) }
            }} /> }>
            <MissionReaderNumber class="w-16" max={pageCount()} value={currentPage() + 1} identity={props.identity}
              label={t("toolCall.permission.diff.page", { page: currentPage() + 1, total: pageCount() })}
              onCommit={next => { if (props.pagination) props.pagination.onPage(next - 1); else setPage(next - 1); article?.scrollIntoView({ block: "nearest" }) }} />
          </Show>
        </label>
        <button type="button" class="window-text-button" onClick={() => void copy()}>{t("markdown.copy")}</button>
        <span role="status">{copyStatus()}</span>
      </div>
    </Show>
    <Show when={props.source} fallback={<Show when={props.raw || content().markdownText === null}
      fallback={<Markdown part={{ type: "text", text: content().markdownText! }} escapeRawHtml instanceId={props.instanceId} />}>
      <pre>{content().sourceText}</pre>
    </Show>}>{source => <MissionPassageSectionContent instanceId={props.instanceId} source={source()} page={page()} raw={props.raw}
      onPageCount={setRemoteCount} />}</Show>
  </article>
}

export function MissionReader(props: { instanceId: string; scope: string }) {
  const { t, locale } = useI18n()
  const target = () => missionProjectView(props.scope).reader
  const projectID = () => instances().get(props.instanceId)?.metadata?.project?.id ?? missionStore.state(props.instanceId).projectID
  const currentPassage = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID,
    directory: () => props.scope, scheduleID: () => target()?.recurrence?.scheduleID,
    active: () => target()?.recurrence?.instanceId === props.instanceId && target()?.recurrence?.projectID === projectID() })
  const passage = () => {
    const owner = target()?.recurrence, snapshot = currentPassage.snapshot()
    return owner?.instanceId === props.instanceId && owner.projectID === projectID() && snapshot?.passageID === owner.passageID
      && snapshot.mission?.id === target()?.missionId ? snapshot : undefined
  }
  const mission = () => target()?.recurrence ? passage()?.mission
    : missionStore.state(props.instanceId).missions.find(m => m.id === target()?.missionId)
  const activity = () => target()?.recurrence ? passage()?.activity : missionStore.state(props.instanceId).activity
  const sectionSource = (label: string): MissionPassageSection | undefined => {
    const owner = target()?.recurrence, value = mission(), kind = target()?.kind
    if (!owner || !value || !kind || kind === "recurrence") return
    const section = label === "missions.tracking.recorded" ? "achieved" : label === "missions.tracking.obstacles" ? "obstacles" : label.split(".").at(-1)!
    if (!["summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles"].includes(section)) return
    return { scheduleID: owner.scheduleID, passageID: owner.passageID, projectID: owner.projectID,
      missionID: value.id, revision: value.revision, kind, itemId: target()?.itemId,
      section: section as MissionPassageSection["section"] }
  }
  const recurrenceProjectID = () => instances().get(props.instanceId)?.metadata?.project?.id ?? missionStore.state(props.instanceId).projectID
  const recurrenceState = useMissionRecurrence({ instanceId: () => props.instanceId, projectID: recurrenceProjectID,
    directory: () => props.scope, active: () => target()?.kind === "recurrence"
      && target()?.instanceId === props.instanceId && target()?.projectID === recurrenceProjectID() })
  const recurrence = () => target()?.instanceId === props.instanceId && target()?.projectID === recurrenceProjectID()
    ? recurrenceState.snapshot()?.schedules.find(schedule => schedule.id === target()?.missionId) : undefined
  const task = () => mission()?.tasks.find(task => task.id === target()?.itemId)
  const reports = createMemo(() => { const value = mission(); return value ? missionReports(value) : [] })
  const report = () => reports().find(report => report.id === target()?.itemId)
  const previousReport = () => {
    const value = mission(), result = report()
    return value && result && missionReportIsPrevious(value, result)
  }
  const change = () => mission()?.history?.find(change => String(change.revision) === target()?.itemId)
  const title = () => target()?.kind === "recurrence" ? t("missions.recurrence.reader", { id: target()?.missionId ?? "" })
    : target()?.kind === "task" ? task()?.title : target()?.kind === "report"
    ? mission()?.tasks.find(task => task.key === report()?.taskKey)?.title ?? report()?.taskKey
    : t(target()?.kind === "change" ? "missions.control.history.title"
      : mission()?.briefing && !mission()?.summary ? "missions.briefing.title" : "missions.control.overview")
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
      const family = activity()?.missions.find(item => item.missionId === value.id)?.family
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
  const sections = createMemo<Array<{ label: string; text: string; raw?: boolean; taskKeys?: string[] }>>(() => {
    if (target()?.kind === "recurrence") return []
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
        { label: "missions.control.report.next", text: value.next.join("\n\n") },
        { label: "missions.control.report.evidence", text: value.evidence.join("\n\n") },
      ] : []
    }
    const value = mission()
    if (value?.briefing && !value.summary) return [
      { label: "missions.control.summary", text: value.briefing.summary },
      ...(["achieved", "ongoing", "obstacles", "next"] as const).map(section => ({
        label: `missions.briefing.${section}`, text: value.briefing![section].map(item => item.text).join("\n\n"),
        taskKeys: [...new Set(value.briefing![section].flatMap(item => item.taskKeys))],
      })),
      { label: "missions.control.objective", text: value.objective },
      { label: "missions.control.notes", text: value.notes ?? "" },
    ]
    const current = value ? missionProgress(value) : undefined
    const recorded = current?.tasks.filter(task => missionTaskReport(value!, task)?.outcome === "completed")
      .sort((a, b) => b.report!.createdAt - a.report!.createdAt).slice(0, 3) ?? []
    const blockers = value?.status === "active" ? current?.blockers.slice(0, 3) ?? [] : []
    return value ? [
      { label: "missions.control.summary", text: value.summary ?? "" },
      ...(!value.summary ? [
        { label: "missions.tracking.recorded", text: recorded.map(task => `${task.title}\n\n${task.report!.summary}`).join("\n\n"), taskKeys: recorded.map(task => task.key) },
        { label: "missions.tracking.obstacles", text: blockers.map(task => `${task.title}\n\n${task.report!.summary}`).join("\n\n"), taskKeys: blockers.map(task => task.key) },
      ] : []),
      { label: "missions.control.objective", text: value.objective },
      { label: "missions.control.notes", text: value.notes ?? "" },
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
    if (!target()?.recurrence && target()?.kind !== "recurrence") void missionStore.ensure(props.instanceId)
    if (document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
    closeButton?.focus()
  })
  onCleanup(() => { disposed = true; if (root?.contains(document.activeElement) && returnFocus?.isConnected) returnFocus.focus() })
  const close = () => { showSessionChat(props.scope); updateMissionProjectView(props.scope, { reader: undefined }) }
   return <section ref={root} class="mission-reader window-shell" aria-label={title() ?? t("missions.control.reader.missing")}
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
      <Show when={target()?.recurrence && currentPassage.error()}><p role="status">{t(passage() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
      <Show when={target()?.kind === "recurrence"}>
        <Show when={recurrenceState.loading() && !recurrenceState.snapshot()}><p role="status">{t("missions.control.loading")}</p></Show>
        <Show when={recurrenceState.error()}><p role="status">{t(recurrenceState.stale() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
        <Show when={recurrence()} fallback={<p>{t("missions.control.reader.missing")}</p>}>{schedule => <>
          <Show when={schedule().pendingStatus}><p role="status">{t(`missions.recurrence.pending.${schedule().pendingStatus}`)}</p></Show>
          <Show when={schedule().history.find(receipt => receipt.passageID === (target()?.itemId ?? schedule().latestResult?.passageID))}>
            {receipt => <Show when={receipt().missionID}><MissionRecurrencePassageReader instanceId={props.instanceId} scope={props.scope}
              projectID={recurrenceState.snapshot()!.projectID} scheduleID={schedule().id} receipt={receipt()} /></Show>}
          </Show>
          <h3>{t("missions.recurrence.history")}</h3>
          <Show when={schedule().history.length} fallback={<p>{t("missions.recurrence.historyEmpty")}</p>}>
            <ol class="mission-recurrence-history"><For each={[...schedule().history].reverse()}>{(receipt, index) =>
              <li><h4>{index() === 0 ? t("missions.recurrence.latest") : t("missions.recurrence.passage")}: {t(`missions.recurrence.result.${receipt.status}`)}</h4>
                <Show when={receipt.missionID}><button type="button" class="window-text-button icon-toggle"
                  aria-label={t("missions.recurrence.readResult", { id: receipt.passageID })}
                  aria-pressed={(target()?.itemId ?? schedule().latestResult?.passageID) === receipt.passageID}
                  onClick={() => updateMissionProjectView(props.scope, { reader: { ...target()!, itemId: receipt.passageID } })}>
                  {t("missions.control.read")}
                </button></Show>
                <dl>
                  <dt>{t("missions.recurrence.passage")}</dt><dd><bdi>{receipt.passageID}</bdi></dd>
                  <dt>{t("missions.recurrence.messageRef")}</dt><dd><bdi>{receipt.messageID}</bdi></dd>
                  <dt>{t("missions.recurrence.due")}</dt><dd><time dateTime={new Date(receipt.dueAt).toISOString()}>{new Date(receipt.dueAt).toLocaleString(locale())}</time></dd>
                  <dt>{t("missions.recurrence.settledAt")}</dt><dd><time dateTime={new Date(receipt.settledAt).toISOString()}>{new Date(receipt.settledAt).toLocaleString(locale())}</time></dd>
                  <Show when={receipt.missionID}><dt>{t("missions.recurrence.missionRef")}</dt><dd><bdi>{receipt.missionID}</bdi></dd></Show>
                  <Show when={receipt.conversationID}><dt>{t("missions.recurrence.conversationRef")}</dt><dd><bdi>{receipt.conversationID}</bdi></dd></Show>
                  <Show when={receipt.artifactMessageIDs?.length}><dt>{t("missions.recurrence.artifactRefs")}</dt><dd><For each={receipt.artifactMessageIDs}>{id => <div><bdi>{id}</bdi></div>}</For></dd></Show>
                </dl></li>
            }</For></ol>
          </Show>
        </>}</Show>
      </Show>
      <Show when={target()?.kind === "overview" && mission()?.briefing && !mission()?.summary}>
        <p class="mission-briefing-meta">{t("missions.briefing.authored")} · {new Date(mission()!.briefing!.createdAt).toLocaleString(locale())}</p>
        <Show when={missionBriefingFreshness(mission()!).changed}><p class="mission-briefing-stale">{t("missions.briefing.changed")}</p></Show>
      </Show>
      <Show when={target()?.kind === "report" && report()?.late}><p>{t("missions.control.report.late")}</p></Show>
      <Show when={target()?.kind === "report" && previousReport() && !report()?.late}>
        <p>{t("missions.progress.previousAttempt")}</p>
      </Show>
      <Show when={target()?.kind === "report" && report()}>{value =>
        <p>{t(`missions.control.report.outcome.${value().outcome}`)}</p>
      }</Show>
      <Show when={target()?.kind !== "recurrence" && target()?.kind === "task" && task() && mission()} fallback={
        <Show when={target()?.kind !== "recurrence"}>
        <Show when={sections().length} fallback={<p>{t(missionStore.state(props.instanceId).status === "loading" ? "missions.control.loading" : "missions.control.reader.missing")}</p>}>
        <For each={sections().map(section => section.label)}>{label => {
          const section = () => sections().find(section => section.label === label)!
          return <Show when={section().text}><MissionReaderSection label={label} text={section().text}
            raw={section().raw} identity={JSON.stringify([props.instanceId, props.scope, target()])} instanceId={props.instanceId} source={sectionSource(label)} />
            <Show when={section().taskKeys?.length}><div class="mission-briefing-sources"><For each={section().taskKeys}>{key => {
              const source = () => mission()?.tasks.find(task => task.key === key)
              return <Show when={source()}>{task => <button type="button" class="window-text-button"
                onClick={() => updateMissionProjectView(props.scope, { reader: { missionId: mission()!.id, kind: "task", itemId: task().id, recurrence: target()?.recurrence } })}>
                {task().title}
              </button>}</Show>
            }}</For></div></Show>
          </Show>
        }}</For>
        </Show>
        </Show>
      }>
        <MissionTaskReader instanceId={props.instanceId} scope={props.scope} mission={mission()!} task={task()!}
          identity={JSON.stringify([props.instanceId, props.scope, target()])} onOpenActor={openActor}
          family={activity()?.missions.find(item => item.missionId === mission()?.id)?.family}
          activity={activity()?.missions.find(item => item.missionId === mission()?.id)?.actors.find(actor => actor.sessionId === task()?.actorSessionId)?.state}
          recurrence={target()?.recurrence} />
      </Show>
      <Show when={target()?.kind === "report" && report()}>{value =>
        <details class="mission-report-technical"><summary>{t("missions.control.task.details")}</summary>
          <MissionReportNotification report={value()} />
          <Show when={value().artifact !== undefined}><MissionReaderSection label="missions.control.artifact"
            text={JSON.stringify(value().artifact, null, 2)} raw
            identity={JSON.stringify([props.instanceId, props.scope, target(), value().id])} instanceId={props.instanceId} source={sectionSource("artifact")} /></Show>
        </details>
      }</Show>
    </div>
  </section>
}
