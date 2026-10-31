import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { ArrowUpRight, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { getSessionPreview, showSessionChatFor } from "../stores/session-previews"
import { Markdown } from "./markdown"
import { copyToClipboard } from "../lib/clipboard"
import { MissionTaskReader } from "./mission-task-reader"
import { MissionReportNotification } from "./mission-native-execution"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { activeSessionId, activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { sessionListRestored } from "../stores/session-list-restoration"
import { missionIncludesSession } from "./mission-attention-model"
import { missionTaskConversation } from "./mission-task-navigation"
import { demandMissionTaskSessions, missionDerivedSessionIncludes, missionDerivedTaskSession } from "../stores/mission-task-sessions"
import { missionReports, missionReportIsPrevious, missionTaskReport, missionProgress } from "./mission-progress-model"
import { missionMarkdownPage } from "../lib/mission-markdown-pages"
import { missionBriefingFreshness } from "./mission-briefing-model"
import { useMissionCurrentPassage } from "../stores/mission-recurrence"
import { MissionPassageSectionContent, type MissionPassageSection } from "./mission-passage-section"

import { useMissionRecurrence } from "../stores/mission-recurrence"
import { MissionRecurrenceReader } from "./mission-recurrence-reader"
import type { MissionMarkdownPage } from "../lib/mission-markdown-pages"
import { MissionReaderNumber } from "./mission-reader-number"
import { MissionOverviewDetails } from "./mission-overview-details"
import { MissionComparisonReport } from "./mission-comparison-report"
import { MissionDecisionReport } from "./mission-decision-report"
import { MissionPlaybookReader } from "./mission-playbook-reader"
import type { MissionBriefing, MissionPlanChange, MissionTemplateId } from "../../../server/src/missions/model"
import type { MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { useMissionBody } from "../stores/mission-content"
import { missionBodyCovers, missionBodyNeed } from "../lib/mission-body-pages"
import { MissionBodyPending, missionReaderBody, useReaderValue, useReaderValues, type MissionBodyRead, type MissionReaderBody } from "./mission-reader-body"
import { useReportBodies } from "./mission-report-prose"
import type { MissionReport } from "../../../server/src/api-types"

// One bounded page per section, including raw artifacts. Leave shared Markdown/tool budgets alone.
const READER_PAGE_SIZE = 9_000
/** A section of `text`, or of `body`, a one-time mission's body read through the content
 * route: only the prefix the shown page needs, the whole of one digest to copy, and only
 * while `active` (an open disclosure). `read` is the state of text formatted from bodies
 * read whole: shown once settled. A failed read shows beside the last good page. */
export function MissionReaderSection(props: { text?: string; body?: MissionReaderBody; active?: boolean; raw?: boolean; identity: string; instanceId: string
  label: string; source?: MissionPassageSection; read?: MissionBodyRead
  pagination?: { page: number; pageCount: number; content: MissionMarkdownPage; onPage: (page: number) => void } }) {
  const { t } = useI18n()
  const [page, setPage] = createSignal(0)
  const [copyStatus, setCopyStatus] = createSignal("")
  const [remoteCount, setRemoteCount] = createSignal<number>()
  const [copying, setCopying] = createSignal(false)
  const remote = useMissionBody(() => props.body && props.active !== false ? props.body : undefined,
    () => copying() ? Infinity : missionBodyNeed(remote.state().body, page(), READER_PAGE_SIZE))
  /** What the section shows: the loaded text, its whole length and the value it is cut from.
   * A plugin without content reads shows the map's own value, whatever was read before. */
  const shown = createMemo(() => {
    if (props.read && !props.read.settled) return undefined
    if (!props.body) return { text: props.text ?? "", characters: (props.text ?? "").length, value: props.text ?? "" }
    const state = remote.state()
    if (state.status === "unsupported") return { text: props.body.fallback, characters: props.body.fallback.length, value: props.body.fallback }
    if (state.status === "missing") return { text: "", characters: 0, value: "" }
    return state.body && { text: state.body.text, characters: state.body.characters, value: state.body.digest }
  })
  /** The section's read: its whole value's, or its own body's. */
  const status = (): MissionBodyRead | undefined => props.read
    ?? (props.body ? { settled: shown() !== undefined, failed: remote.state().status === "error", onRetry: remote.retry } : undefined)
  const currentPage = () => props.pagination?.page ?? page()
  const pageCount = () => props.pagination?.pageCount ?? remoteCount() ?? Math.max(1, Math.ceil((shown()?.characters ?? 0) / READER_PAGE_SIZE))
  let article: HTMLElement | undefined
  const captureCopy = createMissionViewFence(() => JSON.stringify([props.instanceId, props.identity, shown()?.value]), () => true)
  let previousIdentity: string | undefined
  let previousValue: string | undefined
  // A new target or value starts at its first page; a body's later slices arriving do not.
  createEffect(() => {
    const identity = props.identity, value = shown()?.value
    if (identity === previousIdentity && (value === undefined || previousValue === undefined || value === previousValue)) {
      previousValue ??= value
      return
    }
    previousIdentity = identity; previousValue = value
    setPage(0); setCopyStatus(""); setRemoteCount(undefined); setCopying(false)
  })
  const content = createMemo(() => {
    if (props.pagination) return props.pagination.content
    const value = shown()
    return value && missionBodyCovers(value.text, value.characters, page(), READER_PAGE_SIZE)
      ? missionMarkdownPage(value.text, page(), READER_PAGE_SIZE) : undefined
  })
  let copyView: (() => boolean) | undefined
  // A Copy retries a failed read it needs; a read failing meanwhile ends that Copy.
  const copy = () => {
    copyView = captureCopy()
    const read = status()
    if (read?.failed) read.onRetry()
    setCopyStatus(""); setCopying(true)
  }
  // Copies the whole value once read (at once for a section's own text), within its view.
  createEffect(() => {
    if (!copying()) return
    const value = shown()
    if (status()?.failed) { setCopying(false); setCopyStatus(t("markdown.codeBlock.copy.failed")); return }
    if (!value || value.text.length < value.characters) return
    setCopying(false)
    const current = copyView
    if (!current?.()) return
    void copyToClipboard(value.text).then(success => {
      if (current()) setCopyStatus(t(success ? "markdown.codeBlock.copy.copied" : "markdown.codeBlock.copy.failed"))
    })
  })
  return <article ref={article}>
    <h3>{t(props.label)}</h3>
    <Show when={pageCount() > 1 || props.pagination || props.source}>
      <div class="window-toolbar">
        <Show when={pageCount() > 1}><label class="mission-reader-pagination">
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
        </label></Show>
        <button type="button" class="window-text-button" onClick={() => void copy()}>{t("markdown.copy")}</button>
        <span role="status">{copyStatus()}</span>
      </div>
    </Show>
    <Show when={props.source} fallback={<>
      <Show when={content()}>{shownPage => <Show when={props.raw || shownPage().markdownText === null}
        fallback={<Markdown part={{ type: "text", text: shownPage().markdownText! }} escapeRawHtml instanceId={props.instanceId} />}>
        <pre>{shownPage().sourceText}</pre>
      </Show>}</Show>
      <Show when={!content() || status()?.failed}>
        <MissionBodyPending failed={status()?.failed ?? false} onRetry={() => status()?.onRetry()} />
      </Show>
    </>}>{source => <MissionPassageSectionContent instanceId={props.instanceId} source={source()} page={page()} raw={props.raw}
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
    if (!owner || !value || !kind || kind === "recurrence" || kind === "playbook") return
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
  const playbook = () => target()?.kind === "playbook" ? target()!.missionId as MissionTemplateId : undefined
  const title = () => playbook() ? t("missions.playbook.title", { name: t(`missions.control.template.${playbook()}`) })
    : target()?.kind === "recurrence" ? recurrence()?.title ?? t("missions.recurrence.reader", { id: target()?.missionId ?? "" })
    : target()?.kind === "task" ? task()?.title : target()?.kind === "report"
    ? mission()?.tasks.find(task => task.key === report()?.taskKey)?.title ?? report()?.taskKey
    : t(target()?.kind === "change" ? "missions.control.history.title"
      : mission()?.briefing && !mission()?.summary ? "missions.briefing.title" : "missions.control.overview")
  const [navigationError, setNavigationError] = createSignal(false)
  const captureNavigation = createMissionViewFence(() => JSON.stringify([
    props.instanceId, props.scope, target(), instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id, missionStore.state(props.instanceId).projectID,
    activeSessionId().get(props.instanceId), activeParentSessionId().get(props.instanceId), getSessionPreview(activeSessionId().get(props.instanceId) ?? "", props.scope),
  ]), () => Boolean(target()))
  let navigationIntent = 0
  const taskConversation = () => {
    const value = mission(), currentTask = task()
    return value && currentTask && target()?.kind === "task"
      ? missionTaskConversation(value, currentTask, activity()?.missions.find(item => item.missionId === value.id)?.family,
        missionDerivedTaskSession(props.instanceId, value, currentTask.key)) : undefined
  }
  createEffect(() => { const value = mission(); if (value && target()?.kind === "task") demandMissionTaskSessions(props.instanceId, value) })
  const openActor = async (sessionId: string) => {
    const current = captureNavigation(), intent = ++navigationIntent
    const instanceId = props.instanceId, scope = props.scope
    const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const authorized = () => {
      const value = mission()
      const currentTask = task()
      if (!value || target()?.kind !== "task" || !currentTask) return false
      const family = activity()?.missions.find(item => item.missionId === value.id)?.family
      return missionTaskConversation(value, currentTask, family, missionDerivedTaskSession(props.instanceId, value, currentTask.key)) === sessionId
        && (value.coordinatorSessionId === sessionId || missionIncludesSession(value.actors, sessionId, family)
          || missionDerivedSessionIncludes(props.instanceId, value, sessionId))
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
      showSessionChatFor(sessionId, scope)
      updateMissionProjectView(scope, { reader: undefined })
    })
  }
  // A one-time mission's bodies come from the content route; a passage's from its own map.
  const oneTime = () => Boolean(target()) && !target()!.recurrence && target()!.kind !== "recurrence" && target()!.kind !== "playbook"
  const reading = { instanceId: () => props.instanceId, mission, oneTime }
  const readerBody = (selector: MissionContentSelector, fallback: string | undefined) => missionReaderBody(props.instanceId, mission(), oneTime(), selector, fallback)
  const changeObjective = useReaderValue<MissionPlanChange["objective"]>({ ...reading, local: () => change()?.objective,
    selector: () => target()?.kind === "change" && change()?.objective ? { kind: "change", change: change()!.revision, field: "objective" } : undefined })
  const changeNotes = useReaderValue<MissionPlanChange["notes"]>({ ...reading, local: () => change()?.notes,
    selector: () => target()?.kind === "change" && change()?.notes ? { kind: "change", change: change()!.revision, field: "notes" } : undefined })
  const reportBodies = useReportBodies({ ...reading, report: () => target()?.kind === "report" ? report() : undefined })
  const overview = () => target()?.kind === "overview" ? mission() : undefined
  const briefed = () => Boolean(overview()?.briefing && !overview()?.summary)
  const briefing = useReaderValue<MissionBriefing>({ ...reading, local: () => mission()?.briefing,
    selector: () => briefed() ? { kind: "mission", field: "briefing" } : undefined })
  // The overview's latest recorded results and open obstacles, each task's report read whole.
  const progress = createMemo(() => {
    const value = overview()
    if (!value || value.summary || briefed()) return { recorded: [], blockers: [] }
    const current = missionProgress(value)
    return { recorded: current.tasks.filter(task => missionTaskReport(value, task)?.outcome === "completed")
      .sort((a, b) => b.report!.createdAt - a.report!.createdAt).slice(0, 3),
      blockers: value.status === "active" ? current.blockers.slice(0, 3) : [] }
  })
  // Each is its task's current result, read as the task's own copy (shared with its task reader).
  const results = useReaderValues<MissionReport>({ ...reading, items: () => [...progress().recorded, ...progress().blockers].map(task => ({
    selector: { kind: "task" as const, taskKey: task.key, field: "report" }, local: () => task.report })) })
  const resultReads = { value: () => undefined, settled: () => results.read().settled, read: results.read }
  /** A section formatted from a body read whole: present as the map records it, shown once read. */
  const whole = <T,>(read: { value: () => T | undefined; settled: () => boolean; read: () => MissionBodyRead },
    present: boolean, format: (value: T | undefined) => string) => ({ present, text: read.settled() ? format(read.value()) : "", read: read.read() })
  const sections = createMemo<Array<{ label: string; text: string; present?: boolean; raw?: boolean; taskKeys?: string[]; body?: MissionReaderBody
    read?: MissionBodyRead }>>(() => {
    if (target()?.kind === "recurrence" || playbook()) return []
    if (target()?.kind === "change") {
      const value = change()
      const taskName = (key: string) => mission()?.tasks.find(task => task.key === key)?.title ?? key
      const difference = (before: string, after: string) => `### ${t("missions.control.history.before")}\n\n${before || "—"}\n\n### ${t("missions.control.history.after")}\n\n${after || "—"}`
      return value ? [
        { label: "missions.control.summary", text: value.reason ?? t("missions.control.edit"),
          body: value.reason === undefined ? undefined : readerBody({ kind: "change", change: value.revision, field: "reason" }, value.reason) },
        { label: "missions.control.objective", ...whole(changeObjective, Boolean(value.objective), objective => objective ? difference(objective.before, objective.after) : "") },
        { label: "missions.control.notes", ...whole(changeNotes, Boolean(value.notes), notes => notes ? difference(notes.before ?? "", notes.after ?? "") : "") },
        { label: "missions.control.route.title", text: value.addedTaskKeys.map(taskName).join("\n\n") },
        { label: "missions.control.task.status.superseded", text: value.retiredTasks.map(task => `${taskName(task.taskKey)}${task.replacementTaskKey ? ` → ${taskName(task.replacementTaskKey)}` : ""}`).join("\n\n") },
        { label: "missions.control.task.details", text: value.dependencyUpdates.map(task => `## ${taskName(task.taskKey)}\n\n${difference(task.before.map(taskName).join(", "), task.after.map(taskName).join(", "))}`).join("\n\n") },
      ] : []
    }
    if (target()?.kind === "task") return []
    if (target()?.kind === "report") {
      const value = report()
      return value ? [
        { label: "missions.control.summary", present: Boolean(value.summary), ...reportBodies.summary() },
        { label: "missions.control.report.next", ...whole(reportBodies.next, value.next.length > 0, next => (next ?? []).join("\n\n")) },
        { label: "missions.control.report.evidence", ...whole(reportBodies.evidence, value.evidence.length > 0, evidence => (evidence ?? []).join("\n\n")) },
      ] : []
    }
    const value = mission()
    if (!value) return []
    const objective = { label: "missions.control.objective", text: value.objective, body: readerBody({ kind: "mission", field: "objective" }, value.objective) }
    const notes = { label: "missions.control.notes", text: value.notes ?? "", body: value.notes === undefined ? undefined : readerBody({ kind: "mission", field: "notes" }, value.notes) }
    if (briefed()) {
      const recorded = value.briefing!, shown = briefing.value()
      return [
        { label: "missions.control.summary", ...whole(briefing, Boolean(recorded.summary), shown => shown?.summary ?? "") },
        ...(["achieved", "ongoing", "obstacles", "next"] as const).map(section => ({
          label: `missions.briefing.${section}`, ...whole(briefing, recorded[section].some(item => item.text), shown => shown?.[section].map(item => item.text).join("\n\n") ?? ""),
          taskKeys: shown ? [...new Set(shown[section].flatMap(item => item.taskKeys))] : [],
        })),
        objective, notes,
      ]
    }
    const { recorded, blockers } = progress(), summaries = results.values()
    const composed = (tasks: typeof recorded, from: number) => tasks.map((task, index) => `${task.title}\n\n${summaries[from + index]?.summary ?? ""}`).join("\n\n")
    return [
      { label: "missions.control.summary", text: value.summary ?? "", body: value.summary === undefined ? undefined : readerBody({ kind: "mission", field: "summary" }, value.summary) },
      ...(!value.summary ? [
        { label: "missions.tracking.recorded", ...whole(resultReads, recorded.length > 0, () => composed(recorded, 0)), taskKeys: recorded.map(task => task.key) },
        { label: "missions.tracking.obstacles", ...whole(resultReads, blockers.length > 0, () => composed(blockers, recorded.length)), taskKeys: blockers.map(task => task.key) },
      ] : []),
      objective, notes,
    ]
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
  // The reader needs its one-time Mission's full map, open or not. Only the
  // instance and target identities drive the registration, never store publications.
  const wantOwner = `reader:${props.scope}`
  const wantedMission = createMemo(() => {
    const value = target()
    return value && !value.recurrence && value.kind !== "recurrence" && value.kind !== "playbook" ? value.missionId : undefined
  })
  createEffect(() => {
    const instanceId = props.instanceId, missionId = wantedMission()
    untrack(() => missionStore.want(instanceId, wantOwner, missionId))
    onCleanup(() => missionStore.want(instanceId, wantOwner, undefined))
  })
  // A restored reader waits for session-list restoration before its first read.
  createEffect(() => {
    if (sessionListRestored(props.instanceId) && !target()?.recurrence && target()?.kind !== "recurrence" && !playbook()) untrack(() => void missionStore.ensure(props.instanceId))
  })
  onMount(() => {
    if (document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
    closeButton?.focus()
  })
  onCleanup(() => { disposed = true; if (root?.contains(document.activeElement) && returnFocus?.isConnected) returnFocus.focus() })
  const close = () => { showSessionChatFor(activeSessionId().get(props.instanceId) ?? "", props.scope); updateMissionProjectView(props.scope, { reader: undefined }) }
   return <section ref={root} class="mission-reader window-shell" aria-label={title() ?? t("missions.control.reader.missing")}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close() } }}>
    <header class="window-header">
      <h2 class="window-title">{title()}</h2>
      <Show when={taskConversation()}>{id => <button type="button" class="window-action mission-reader-open"
        onClick={() => void openActor(id())}><ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" />{t("missionsPanel.action.openConversation")}</button>}</Show>
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
        <Show when={recurrence()} fallback={<p>{t("missions.control.reader.missing")}</p>}>{schedule =>
          <MissionRecurrenceReader instanceId={props.instanceId} scope={props.scope} projectID={recurrenceState.snapshot()!.projectID}
            schedule={schedule()} passageID={target()?.itemId}
            onSelect={passageID => updateMissionProjectView(props.scope, { reader: { ...target()!, itemId: passageID } })} />}</Show>
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
      <Show when={playbook()}>{id => <MissionPlaybookReader playbook={id()} taskMode={target()?.taskMode ?? "native"} />}</Show>
      <Show when={target()?.kind !== "recurrence" && target()?.kind === "task" && task() && mission()} fallback={
        <Show when={target()?.kind !== "recurrence" && !playbook()}>
        <Show when={sections().length} fallback={<p>{t(missionStore.state(props.instanceId).status === "loading" ? "missions.control.loading" : "missions.control.reader.missing")}</p>}>
        <For each={sections().map(section => section.label)}>{label => {
          const section = () => sections().find(section => section.label === label)!
          return <Show when={section().present ?? section().text}><MissionReaderSection label={label} text={section().text} body={section().body}
            read={section().read} raw={section().raw} identity={JSON.stringify([props.instanceId, props.scope, target()])} instanceId={props.instanceId}
            source={sectionSource(label)} />
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
          identity={JSON.stringify([props.instanceId, props.scope, target()])}
          activity={activity()?.missions.find(item => item.missionId === mission()?.id)?.actors.find(actor => actor.sessionId === task()?.actorSessionId)?.state}
          recurrence={target()?.recurrence} />
      </Show>
      <Show when={target()?.kind === "overview" && mission()}>{value =>
        <MissionOverviewDetails instanceId={props.instanceId} scope={props.scope} mission={value()} recurrence={target()?.recurrence} />}</Show>
      <Show when={target()?.kind === "report" && report()}>{value => <>
        <MissionComparisonReport artifact={reportBodies.artifact.value()} profiles={mission()?.profiles} identity={JSON.stringify([props.instanceId, props.scope, target(), value().id])} instanceId={props.instanceId} />
        <Show when={mission()}>{map => <MissionDecisionReport mission={map()} report={value()} artifact={reportBodies.artifact.value()}
          identity={JSON.stringify([props.instanceId, props.scope, target(), value().id])} instanceId={props.instanceId} />}</Show>
        <details class="mission-report-technical"><summary>{t("missions.control.task.details")}</summary>
          <MissionReportNotification report={value()} />
          <Show when={value().artifact !== undefined}><MissionReaderSection label="missions.control.artifact" raw
            text={reportBodies.artifact.settled() ? JSON.stringify(reportBodies.artifact.value(), null, 2) : ""} read={reportBodies.artifact.read()}
            identity={JSON.stringify([props.instanceId, props.scope, target(), value().id])} instanceId={props.instanceId} source={sectionSource("artifact")} /></Show>
        </details>
      </>}</Show>
    </div>
  </section>
}
