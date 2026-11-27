import { Show, createUniqueId } from "solid-js"
import type { SessionAutomation } from "../../../../server/src/opencode/automation-contract"
import { useI18n } from "../../lib/i18n"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, getRenderTextWindow } from "../../lib/render-text-window"
import { OutputWindow } from "../output-window"

interface SessionAutomationDetailDialogProps {
  open: boolean
  automation: SessionAutomation | null
  returnFocus?: () => HTMLElement | undefined
  onClose: () => void
}

function bounded(text: string): string {
  const window = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  return window.hidden > 0 ? `${window.text}…` : window.text
}

function formatTriggerRule(
  automation: SessionAutomation,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const trigger = automation.trigger
  if (trigger.type === "at") return t("instanceShell.automations.trigger.at", { value: trigger.at })
  if (trigger.type === "every") return t("instanceShell.automations.trigger.every", { value: trigger.every })
  if (trigger.type === "cron") return t("instanceShell.automations.trigger.cron", { value: trigger.cron })
  return `${trigger.server} / ${trigger.event}`
}

export function SessionAutomationDetailDialog(props: SessionAutomationDetailDialogProps) {
  const { t, locale } = useI18n()
  const id = `session-automation-detail-${createUniqueId()}`
  const formatDate = (value: number) => new Date(value).toLocaleString(locale(), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  })

  return (
    <OutputWindow
      id={id}
      open={props.open && Boolean(props.automation)}
      title={props.automation ? bounded(props.automation.name) : t("instanceShell.automations.label")}
      subtitle={props.automation ? formatTriggerRule(props.automation, t) : undefined}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
    >
      <Show when={props.automation}>
        {(current) => {
          const actionPayload = () => {
            const action = current().action
            if (action.type === "prompt") return { label: t("instanceShell.automations.detail.action.prompt"), text: action.prompt }
            if (action.type === "shell") return { label: t("instanceShell.automations.detail.action.shell"), text: action.command }
            return { label: t("instanceShell.automations.detail.action.code"), text: action.code }
          }
          const subagentTarget = () => {
            const action = current().action
            return action.type === "prompt" ? action.target?.subagent : undefined
          }
          return (
            <>
              <dl class="session-automation-detail-grid">
                <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.status")}</dt>
                <dd class="session-automation-detail-value">{t(`instanceShell.automations.status.${current().status}`)}</dd>
                <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.trigger")}</dt>
                <dd class="session-automation-detail-value">
                  {formatTriggerRule(current(), t)}
                  <Show when={current().trigger.type !== "event" && current().tz}>
                    {` (${current().tz})`}
                  </Show>
                </dd>
                <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.runs")}</dt>
                <dd class="session-automation-detail-value">{current().runCount}</dd>
                <Show when={current().nextDueAt !== undefined}>
                  <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.nextRun")}</dt>
                  <dd class="session-automation-detail-value">{formatDate(current().nextDueAt!)}</dd>
                </Show>
                <Show when={current().lastRunAt !== undefined}>
                  <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.lastRun")}</dt>
                  <dd class="session-automation-detail-value">{formatDate(current().lastRunAt!)}</dd>
                </Show>
                <Show when={current().lastOutcome !== undefined}>
                  <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.lastOutcome")}</dt>
                  <dd class="session-automation-detail-value">{t(`instanceShell.automations.outcome.${current().lastOutcome}`)}</dd>
                </Show>
                <Show when={current().expires !== undefined}>
                  <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.expires")}</dt>
                  <dd class="session-automation-detail-value">{formatDate(current().expires!)}</dd>
                </Show>
                <Show when={subagentTarget()}>
                  {(subagent) => (
                    <>
                      <dt class="session-automation-detail-label">{t("instanceShell.automations.detail.subagent")}</dt>
                      <dd class="session-automation-detail-value">{subagent()}</dd>
                    </>
                  )}
                </Show>
              </dl>

              <div class="session-automation-detail-section">
                <div class="session-automation-detail-heading">{actionPayload().label}</div>
                <pre class="border border-base bg-surface-inset p-3 font-mono text-xs text-primary whitespace-pre-wrap break-words">{bounded(actionPayload().text)}</pre>
              </div>

              <Show when={current().lastOutput}>
                {(output) => (
                  <div class="session-automation-detail-section">
                    <div class="session-automation-detail-heading">{t("instanceShell.automations.detail.lastOutput")}</div>
                    <pre class="border border-base bg-surface-inset p-3 font-mono text-xs text-primary whitespace-pre-wrap break-words">{bounded(output())}</pre>
                  </div>
                )}
              </Show>

              <Show when={current().stateJson}>
                {(stateJson) => (
                  <div class="session-automation-detail-section">
                    <div class="session-automation-detail-heading">{t("instanceShell.automations.detail.state")}</div>
                    <pre class="border border-base bg-surface-inset p-3 font-mono text-xs text-primary whitespace-pre-wrap break-words">{bounded(stateJson())}</pre>
                  </div>
                )}
              </Show>
            </>
          )
        }}
      </Show>
    </OutputWindow>
  )
}
