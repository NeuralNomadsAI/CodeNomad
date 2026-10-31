import { Show, createEffect, createMemo, createUniqueId, onCleanup, type Component } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { Pause, Play, Trash2 } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, getRenderTextWindow } from "../../lib/render-text-window"
import { runSessionGoalCommand, sessionGoals } from "../../stores/session-goal"

interface SessionGoalLineProps {
  instanceId: string
  sessionId: string
  /** The Status tab is shown: read and track the Session's goal. */
  active: boolean
}

// Plain text in one line and a tooltip, bounded like other plain text blocks
// (dev-docs/TEXT_DISPLAY_BOUNDS.md); the plugin itself caps objectives far below.
function boundedText(text: string): string {
  const window = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  return window.hidden > 0 ? `${window.text}…` : window.text
}

/** The shown Session's `/goal` on one line above the Status sections; nothing without a goal. */
const SessionGoalLine: Component<SessionGoalLineProps> = (props) => {
  const { t } = useI18n()
  const reasonId = createUniqueId()
  createEffect(() => {
    if (!props.active) return
    onCleanup(sessionGoals.demand(props.instanceId, props.sessionId))
  })
  const goal = createMemo(() => {
    const snapshot = sessionGoals.state(props.instanceId, props.sessionId)
    return snapshot.status === "goal" ? snapshot.goal : null
  })
  const busy = () => sessionGoals.busy(props.instanceId, props.sessionId)
  const run = (action: "pause" | "resume" | "clear") => void runSessionGoalCommand(props.instanceId, props.sessionId, action)

  return (
    <Show when={goal()}>
      {(current) => {
        const objective = createMemo(() => boundedText(current().objective))
        const reason = createMemo(() => current().reason ? boundedText(current().reason!) : "")
        const rounds = () => t("instanceShell.goal.rounds", { rounds: current().rounds, max: current().maxRounds })
        // One control for Pause and Resume keeps keyboard focus when the status flips.
        const toggleLabel = () => t(current().status === "paused" ? "instanceShell.goal.actions.resume" : "instanceShell.goal.actions.pause")
        return (
          <div class="session-goal-line" role="group" aria-label={t("instanceShell.goal.label")}
            aria-describedby={reason() ? reasonId : undefined} aria-busy={busy()} data-status={current().status}>
            <Tooltip placement="bottom-start" openDelay={300}>
              <Tooltip.Trigger as="span" tabindex="0" class="session-goal-summary">
                <span class="session-goal-badge" data-status={current().status}>{t(`instanceShell.goal.status.${current().status}`)}</span>
                <span class="session-goal-objective"><bdi>{objective()}</bdi></span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content class="section-info-tooltip session-goal-tooltip">
                  <p><bdi>{objective()}</bdi></p>
                  <Show when={reason()}><p class="session-goal-tooltip-reason"><bdi>{reason()}</bdi></p></Show>
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip>
            <Show when={reason()}><span id={reasonId} class="sr-only">{reason()}</span></Show>
            <span class="session-goal-rounds" title={rounds()}>
              <span aria-hidden="true">{current().rounds}/{current().maxRounds}</span>
              <span class="sr-only">{rounds()}</span>
            </span>
            <Show when={current().status !== "complete"}>
              <button type="button" class="window-icon-button" aria-label={toggleLabel()} title={toggleLabel()} disabled={busy()}
                onClick={() => run(current().status === "paused" ? "resume" : "pause")}>
                <Show when={current().status === "paused"} fallback={<Pause aria-hidden="true" />}><Play aria-hidden="true" /></Show>
              </button>
            </Show>
            <button type="button" class="window-icon-button" aria-label={t("instanceShell.goal.actions.clear")}
              title={t("instanceShell.goal.actions.clear")} disabled={busy()} onClick={() => run("clear")}>
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        )
      }}
    </Show>
  )
}

export default SessionGoalLine
