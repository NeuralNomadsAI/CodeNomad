import { For, Show, createMemo, type Component } from "solid-js"

import type { MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { sessions } from "../stores/sessions"
import { describeMissionExecution } from "./mission-execution-model"

const MISSION_EXECUTION_FIELDS = [
  { key: "agent", label: "missions.control.execution.agent" },
  { key: "model", label: "missions.control.execution.model" },
  { key: "variant", label: "missions.control.execution.variant" },
] as const

/**
 * Read-only comparison of what a task requested against what its actor session
 * currently reports. Partial requests render as the native default, missing
 * session data as unknown, and nothing here re-routes or reconfigures an actor.
 */
export const MissionExecution: Component<{ instanceId: string; task: MissionTask }> = (props) => {
  const { t } = useI18n()
  const view = createMemo(() => {
    const sessionId = props.task.actorSessionId
    return describeMissionExecution(
      props.task,
      sessionId ? sessions().get(props.instanceId)?.get(sessionId) : undefined,
    )
  })
  const native = () => props.task.executionMode?.kind === "native" || Boolean(props.task.nativeBinding)
  const drift = createMemo(() => MISSION_EXECUTION_FIELDS.some(field => view()[field.key].match === "differs"))

  return (
    <div class="mission-execution" aria-label={t("missions.control.execution.title")}>
      <dl class="mission-execution-grid">
        <For each={MISSION_EXECUTION_FIELDS}>
          {(field) => {
            const value = () => view()[field.key]
            return (
              <div class="mission-execution-row" data-match={value().match}>
                <dt>{t(field.label)}</dt>
                <dd>
                  <span class="mission-execution-cell" data-state={value().request}>
                    <small>{t("missions.control.execution.requested")}</small>
                    {value().requested ?? t("missions.control.execution.nativeDefault")}
                  </span>
                  <span class="mission-execution-cell" data-state={value().observed}>
                    <small>{t(native() ? "missions.control.native.profile" : "missions.control.execution.current")}</small>
                    {value().current ?? t("missions.control.execution.unknown")}
                  </span>
                </dd>
              </div>
            )
          }}
        </For>
      </dl>
      <Show when={!view().pinned}>
        <p class="mission-execution-note">{t("missions.control.execution.empty")}</p>
      </Show>
      <Show when={drift()}>
        <p class="mission-execution-note mission-execution-note-drift" role="status">
          {t("missions.control.execution.drift")}
        </p>
      </Show>
    </div>
  )
}

export default MissionExecution
export * from "./mission-execution-model"
