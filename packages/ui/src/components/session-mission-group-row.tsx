import { Component, Show, createMemo } from "solid-js"
import { ChevronRight, Flag, ShieldAlert } from "lucide-solid"
import type { SessionThread } from "../stores/session-tree"
import { getSessionStatus } from "../stores/session-status"
import { useI18n } from "../lib/i18n"

interface SessionMissionGroupRowProps {
  instanceId: string
  missions: readonly SessionThread[]
  open: boolean
  isLastRow: boolean
  onToggle: () => void
}

/** One collapsible row gathering every Mission root at the end of the list. Its
 * aggregate badge keeps waiting input or running work visible while collapsed. */
const SessionMissionGroupRow: Component<SessionMissionGroupRowProps> = (props) => {
  const { t } = useI18n()
  const activity = createMemo(() => {
    let needsInput = false, working = false
    const visit = (thread: SessionThread) => {
      const session = thread.session
      if (session.pendingPermission || session.pendingForm) needsInput = true
      else if (getSessionStatus(props.instanceId, session.id) !== "idle") working = true
      thread.children.forEach(visit)
    }
    props.missions.forEach(visit)
    return needsInput ? "input" : working ? "working" : null
  })
  const count = () => props.missions.length
  const countLabel = () => t(count() === 1 ? "sessionList.missions.count.one" : "sessionList.missions.count.other", { count: String(count()) })

  return (
    <div class={`session-list-item session-mission-group ${props.isLastRow ? "session-list-item-last" : ""}`}>
      <button
        type="button"
        class="session-item-base session-mission-group-toggle session-item-inactive"
        aria-expanded={props.open}
        aria-label={`${t("sessionList.missions.group.title")}, ${countLabel()}${activity() === "input" ? `, ${t("sessionList.status.needsInput")}` : activity() === "working" ? `, ${t("sessionList.status.working")}` : ""}`}
        title={props.open ? t("sessionList.missions.group.collapse") : t("sessionList.missions.group.expand")}
        data-mission-group-row
        onClick={() => props.onToggle()}
      >
        <span class="session-item-expander" aria-hidden="true">
          <ChevronRight class="disclosure-chevron w-3.5 h-3.5" />
        </span>
        <Flag class="session-item-kind-icon session-mission-group-icon w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span class="session-item-title session-item-title--clamp">{t("sessionList.missions.group.title")}</span>
        <span class="session-item-badges">
          <Show when={activity()}>
            {(state) => (
              <span
                class={`status-indicator session-status session-status-list ${state() === "input" ? "session-permission" : "session-working"} notranslate`}
                translate="no"
                data-mission-group-activity={state()}
              >
                {state() === "input" ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
                <span class="session-item-status-label">
                  {state() === "input" ? t("sessionList.status.needsInput") : t("sessionList.status.working")}
                </span>
              </span>
            )}
          </Show>
          <span class="neutral-badge badge-shape session-mission-group-count" title={countLabel()}>{count()}</span>
        </span>
      </button>
    </div>
  )
}

export default SessionMissionGroupRow
