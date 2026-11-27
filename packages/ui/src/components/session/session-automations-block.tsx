import { For, Show, createComputed, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { ChevronRight, Pause, Play, Trash2 } from "lucide-solid"
import type { SessionAutomation } from "../../../../server/src/opencode/automation-contract"
import { useI18n } from "../../lib/i18n"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, getRenderTextWindow } from "../../lib/render-text-window"
import { backendEvents as serverEvents } from "../../lib/server-events"
import { showConfirmDialog } from "../../stores/alerts"
import { runSessionAutomationAction, sessionAutomations } from "../../stores/session-automations"
import { SessionAutomationDetailDialog } from "./session-automation-detail-dialog"

interface SessionAutomationsBlockProps {
  instanceId: string
  sessionId: string
  /** The Status tab is shown: read and track the Session's automations. */
  active: boolean
}

const TOOLTIP_OUTPUT_LIMIT = 240

function boundedText(text: string, limit = TOOL_OUTPUT_RENDER_CHARACTER_LIMIT): string {
  const window = getRenderTextWindow(text, limit)
  return window.hidden > 0 ? `${window.text}…` : window.text
}

function formatTriggerSummary(automation: SessionAutomation): string {
  const trigger = automation.trigger
  if (trigger.type === "every") return trigger.every
  if (trigger.type === "cron") return trigger.cron
  if (trigger.type === "at") return trigger.at
  return `${trigger.server}/${trigger.event}`
}

function formatShortDue(epochMs: number, locale: string): string {
  const target = new Date(epochMs)
  const now = new Date()
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate()
  return sameDay
    ? target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : target.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatDateTime(epochMs: number, locale: string): string {
  return new Date(epochMs).toLocaleString(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  })
}

function sortLiveAutomations(items: readonly SessionAutomation[]): SessionAutomation[] {
  return [...items].sort((left, right) => {
    const leftFailed = left.lastOutcome === "failed" ? 0 : 1
    const rightFailed = right.lastOutcome === "failed" ? 0 : 1
    if (leftFailed !== rightFailed) return leftFailed - rightFailed
    const leftPaused = left.status === "paused" ? 1 : 0
    const rightPaused = right.status === "paused" ? 1 : 0
    if (leftPaused !== rightPaused) return leftPaused - rightPaused
    if (left.status === "active" && right.status === "active") {
      const leftDue = left.nextDueAt ?? Number.POSITIVE_INFINITY
      const rightDue = right.nextDueAt ?? Number.POSITIVE_INFINITY
      if (leftDue !== rightDue) return leftDue - rightDue
    }
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  })
}

function sortDoneAutomations(items: readonly SessionAutomation[]): SessionAutomation[] {
  return [...items].sort((left, right) =>
    (right.lastRunAt ?? right.updatedAt) - (left.lastRunAt ?? left.updatedAt) || left.id.localeCompare(right.id))
}

/** The shown Session's `/automation` items above the Status sections; nothing without automations. */
const SessionAutomationsBlock: Component<SessionAutomationsBlockProps> = (props) => {
  const { t, locale } = useI18n()
  const [showDone, setShowDone] = createSignal(false)
  const [detailId, setDetailId] = createSignal<string | null>(null)
  let detailReturnTarget: HTMLElement | undefined
  let blockRef: HTMLDivElement | undefined
  let focusSnapshot: { element: HTMLElement; rowId: string | null; fallback: HTMLElement | null } | null = null
  let viewAbort = new AbortController()

  createEffect(() => {
    props.instanceId
    props.sessionId
    props.active
    const controller = new AbortController()
    viewAbort = controller
    setShowDone(false)
    setDetailId(null)
    onCleanup(() => controller.abort())
  })

  createEffect(() => {
    if (!props.active) return
    onCleanup(sessionAutomations.demand(props.instanceId, props.sessionId))
  })

  const automations = createMemo<readonly SessionAutomation[]>(() => {
    const snapshot = sessionAutomations.state(props.instanceId, props.sessionId)
    return snapshot.status === "ok" ? snapshot.automations : []
  })

  const byId = createMemo(() => new Map(automations().map(item => [item.id, item])))
  const live = createMemo(() => sortLiveAutomations(automations().filter(item => item.status !== "done")))
  const done = createMemo(() => sortDoneAutomations(automations().filter(item => item.status === "done")))
  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index])
  const liveIds = createMemo(() => live().map(item => item.id), undefined, { equals: sameIds })
  const doneIds = createMemo(() => done().map(item => item.id), undefined, { equals: sameIds })
  const detailAutomation = createMemo(() => {
    const id = detailId()
    return id ? byId().get(id) ?? null : null
  })

  createComputed(() => {
    liveIds()
    doneIds()
    const active = document.activeElement
    if (active instanceof HTMLElement && blockRef?.contains(active)) {
      focusSnapshot = {
        element: active,
        rowId: active.closest<HTMLElement>("[data-automation-id]")?.getAttribute("data-automation-id") ?? null,
        fallback: blockRef.parentElement?.querySelector<HTMLElement>("[data-status-section-trigger]") ?? null,
      }
    } else {
      focusSnapshot = null
    }
  })

  createEffect(() => {
    liveIds()
    doneIds()
    const snapshot = focusSnapshot
    focusSnapshot = null
    if (!snapshot || document.activeElement !== document.body) return
    if (snapshot.element.isConnected) {
      snapshot.element.focus({ preventScroll: true })
      return
    }
    const movedToFoldedDone = Boolean(snapshot.rowId && !showDone() && done().some(item => item.id === snapshot.rowId))
    const doneToggle = blockRef?.querySelector<HTMLElement>(".session-automations-done-toggle") ?? null
    const firstSummary = blockRef?.querySelector<HTMLElement>(".session-automation-summary") ?? null
    const candidates = movedToFoldedDone
      ? [doneToggle, firstSummary, snapshot.fallback]
      : [firstSummary, doneToggle, snapshot.fallback]
    candidates.find(element => element?.isConnected)?.focus({ preventScroll: true })
  })

  createEffect(() => {
    if (detailId() && !detailAutomation()) setDetailId(null)
  })

  const deleteAutomation = async (item: SessionAutomation, source: HTMLButtonElement) => {
    const instanceId = props.instanceId
    const sessionId = props.sessionId
    if (sessionAutomations.busy(instanceId, sessionId, item.id)) return
    const row = source.closest(".session-automation-row")
    const next = row?.nextElementSibling?.querySelector<HTMLElement>(".session-automation-summary, .window-icon-button")
      ?? row?.previousElementSibling?.querySelector<HTMLElement>(".session-automation-summary, .window-icon-button")
    const block = row?.closest(".session-automations-block")
    const fallback = block?.parentElement?.querySelector<HTMLElement>("[data-status-section-trigger]")
    const returnFocus = () => {
      const target = [source, next, fallback].find(element => element?.isConnected)
      target?.focus({ preventScroll: true })
    }
    const attachment = serverEvents.signalForInstance(instanceId)
    const confirmSignal = attachment ? AbortSignal.any([viewAbort.signal, attachment]) : viewAbort.signal
    if (confirmSignal.aborted) return
    const confirmed = await showConfirmDialog(
      t("instanceShell.automations.delete.message", { name: boundedText(item.name, 120) }),
      {
        title: t("instanceShell.automations.delete.title"),
        confirmLabel: t("instanceShell.automations.actions.delete"),
        returnFocus,
      },
      confirmSignal,
    )
    if (!confirmed || confirmSignal.aborted) return
    const deleted = await runSessionAutomationAction(instanceId, sessionId, item.id, "delete")
    if (deleted && detailId() === item.id) setDetailId(null)
    if (!source.isConnected && document.activeElement === document.body) returnFocus()
  }

  const renderRow = (id: string) => {
    const item = createMemo<SessionAutomation>(previous => byId().get(id) ?? previous!)
    const busy = () => sessionAutomations.busy(props.instanceId, props.sessionId, id)
    const name = createMemo(() => boundedText(item().name))
    const meta = createMemo(() => {
      const current = item()
      const schedule = current.status === "active" && current.nextDueAt !== undefined
        ? formatShortDue(current.nextDueAt, locale())
        : formatTriggerSummary(current)
      return current.runCount > 0
        ? `${schedule} · ${t("instanceShell.automations.runsShort", { count: current.runCount })}`
        : schedule
    })
    const toggleLabel = () => t(item().status === "paused"
      ? "instanceShell.automations.actions.resume"
      : "instanceShell.automations.actions.pause")

    const togglePause = () => {
      if (busy()) return
      void runSessionAutomationAction(
        props.instanceId,
        props.sessionId,
        id,
        item().status === "paused" ? "resume" : "pause",
      )
    }

    return (
      <div
        class="session-automation-row"
        data-automation-id={id}
        data-status={item().status}
        data-outcome={item().lastOutcome}
        aria-busy={busy()}
      >
        <Tooltip placement="bottom-start" openDelay={300}>
          <Tooltip.Trigger
            as="button"
            type="button"
            class="session-automation-summary"
            onClick={(event: MouseEvent) => {
              detailReturnTarget = event.currentTarget as HTMLElement
              setDetailId(id)
            }}
          >
            <span
              class="session-automation-badge"
              data-status={item().status}
              data-outcome={item().lastOutcome === "failed" ? "failed" : undefined}
            >
              {t(`instanceShell.automations.status.${item().status}`)}
            </span>
            <span class="session-automation-name"><bdi>{name()}</bdi></span>
            <span class="session-automation-meta">{meta()}</span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="section-info-tooltip session-automation-tooltip">
              <p><bdi>{name()}</bdi></p>
              <p class="session-automation-tooltip-meta">
                {formatTriggerSummary(item())}
                <Show when={item().trigger.type !== "event" && item().tz}>{` (${item().tz})`}</Show>
              </p>
              <Show when={item().nextDueAt !== undefined}>
                <p class="session-automation-tooltip-meta">
                  {t("instanceShell.automations.tooltip.nextRun", { date: formatDateTime(item().nextDueAt!, locale()) })}
                </p>
              </Show>
              <Show when={item().lastRunAt !== undefined}>
                <p class="session-automation-tooltip-meta">
                  {t("instanceShell.automations.tooltip.lastRun", { date: formatDateTime(item().lastRunAt!, locale()) })}
                  <Show when={item().lastOutcome}>
                    {(outcome) => ` · ${t(`instanceShell.automations.outcome.${outcome()}`)}`}
                  </Show>
                </p>
              </Show>
              <Show when={item().lastRunAt === undefined && item().lastOutcome}>
                {(outcome) => (
                  <p class="session-automation-tooltip-meta">
                    {t(`instanceShell.automations.outcome.${outcome()}`)}
                  </p>
                )}
              </Show>
              <Show when={item().lastOutput}>
                {(output) => (
                  <p class="session-automation-tooltip-meta">
                    <bdi>{boundedText(output(), TOOLTIP_OUTPUT_LIMIT)}</bdi>
                  </p>
                )}
              </Show>
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip>

        <Show when={item().status !== "done"}>
          <button
            type="button"
            class="window-icon-button"
            aria-label={toggleLabel()}
            title={toggleLabel()}
            aria-disabled={busy()}
            onClick={togglePause}
          >
            <Show when={item().status === "paused"} fallback={<Pause aria-hidden="true" />}>
              <Play aria-hidden="true" />
            </Show>
          </button>
        </Show>

        <button
          type="button"
          class="window-icon-button"
          aria-label={t("instanceShell.automations.actions.delete")}
          title={t("instanceShell.automations.actions.delete")}
          aria-disabled={busy()}
          onClick={(event) => void deleteAutomation(item(), event.currentTarget)}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <Show when={automations().length > 0}>
      <div ref={blockRef} class="session-automations-block" role="group" aria-label={t("instanceShell.automations.label")}>
        <For each={liveIds()}>{renderRow}</For>
        <Show when={done().length > 0}>
          <button
            type="button"
            class="session-automations-done-toggle"
            aria-expanded={showDone()}
            onClick={() => setShowDone(current => !current)}
          >
            <ChevronRight class="session-automations-done-chevron" aria-hidden="true" />
            <span>{t("instanceShell.automations.doneToggle", { count: done().length })}</span>
          </button>
          <Show when={showDone()}>
            <For each={doneIds()}>{renderRow}</For>
          </Show>
        </Show>
        <SessionAutomationDetailDialog
          open={Boolean(detailAutomation())}
          automation={detailAutomation()}
          returnFocus={() => detailReturnTarget}
          onClose={() => setDetailId(null)}
        />
      </div>
    </Show>
  )
}

export default SessionAutomationsBlock
