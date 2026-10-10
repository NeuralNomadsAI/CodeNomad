import { Show, createSignal, createUniqueId, onCleanup } from "solid-js"
import { RefreshCw } from "lucide-solid"
import type { MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { canRecoverMissionReport } from "./mission-native-execution-model"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"

export type MissionRecoveryButtonProps = {
  instanceId: string
  mission: MissionMap
  activity?: MissionActorActivity["state"]
  disabled?: boolean
  /** Refresh display state only; admission is not proof of consumption or completion. */
  onAdmitted: () => void | Promise<void>
} & ({ target: "coordinator"; taskKey?: never } | { target: "report"; taskKey: string })

// Window-local mutation guards survive row remounts, not application restarts.
// The backend owns the stable native ID and authoritative deduplication.
const [attempts, setAttempts] = createSignal(new Map<string, "pending" | "admitted">())
function markAttempt(key: string, state?: "pending" | "admitted") {
  setAttempts(previous => {
    const next = new Map(previous)
    if (state) next.set(key, state)
    else next.delete(key)
    // Bound settled guards without ever evicting an in-flight admission.
    for (const [oldKey, oldState] of next) {
      if (next.size <= 128) break
      if (oldKey !== key && oldState === "admitted") next.delete(oldKey)
    }
    return next
  })
}

function classify(error: unknown): "busy" | "unknown" | "conflict" | "failed" {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "recovery-busy") return "busy"
  if (code === "recovery-unknown") return "unknown"
  if (["recovery-conflict", "revision-conflict", "mission-not-running", "control-pending", "mission-not-found", "foreign-session"].includes(String(code))) return "conflict"
  return "failed"
}

export function createMissionRecoveryAction(props: MissionRecoveryButtonProps) {
  const { t } = useI18n()
  const descriptionId = createUniqueId()
  const [error, setError] = createSignal<{ key: string; kind: ReturnType<typeof classify> }>()
  let disposed = false
  onCleanup(() => { disposed = true })
  const key = () => JSON.stringify([props.instanceId, props.mission.id, props.mission.revision, props.target, props.taskKey ?? ""])
  const state = () => attempts().get(key())
  const label = () => t(`missions.recovery.${props.target}`)
  const currentError = () => error()?.key === key() ? error() : undefined
  const eligible = () => {
    const mission = props.mission
    if (mission.status !== "active" || (mission.runState ?? "running") !== "running" || mission.control?.pending.length) return false
    const task = props.target === "report" ? mission.tasks.find(task => task.key === props.taskKey) : undefined
    if (props.target === "report" && !canRecoverMissionReport(task, props.activity)) return false
    const sessionId = props.target === "report" ? task?.actorSessionId : mission.coordinatorSessionId
    const actor = mission.actors.find(actor => actor.sessionId === sessionId)
    if (!actor) return false
    // Unknown projection is not idle. A report recovery may still ask the backend
    // to verify; coordinator recovery is offered only on observed idle-without-report
    // (which already excludes active descendants), never on unknown.
    if (props.target === "coordinator" && props.activity !== "idle-without-report") return false
    if (props.activity && !["unknown", "idle-without-report"].includes(props.activity)) return false
    // Legacy/local actor status can be stale after detachment. The native
    // sidecar wins; unknown still requires authoritative verification on click.
    return true
  }
  async function recover() {
    if (!eligible() || props.disabled || state()) return
    const requestKey = key()
    const instanceId = props.instanceId
    const mission = props.mission
    const input = { expectedRevision: mission.revision, target: props.target,
      ...(props.target === "report" ? { taskKey: props.taskKey } : {}) }
    markAttempt(requestKey, "pending")
    setError(undefined)
    try {
      const response = await serverApi.recoverMission(instanceId, mission.id, input)
      if (response.admitted !== true) throw { code: "recovery-unknown" }
      markAttempt(requestKey, "admitted")
    } catch (failure) {
      markAttempt(requestKey)
      if (!disposed && key() === requestKey) setError({ key: requestKey, kind: classify(failure) })
      return
    }
    if (!disposed && key() === requestKey) {
      // Refresh failures belong to the caller's display-state handling. Never
      // turn them into another native mutation or a misleading admission failure.
      try { await props.onAdmitted() } catch { /* No replay. */ }
    }
  }
  return {
    action: (): ActionOverflowMenuItem | undefined => eligible() ? {
      key: "recovery", label: label(), icon: <RefreshCw class="h-4 w-4" aria-hidden="true" />,
      disabled: props.disabled || Boolean(state()), onSelect: recover,
      description: state() === "pending" ? t("missions.recovery.pending") : currentError() ? t(`missions.recovery.error.${currentError()!.kind}`) : undefined,
    } : undefined,
    feedback: <Show when={eligible()}>
      <Show when={state() === "pending"}><small id={descriptionId} role="status">{t("missions.recovery.pending")}</small></Show>
      <Show when={currentError()}>{failure => <small id={descriptionId} role="alert">{t(`missions.recovery.error.${failure().kind}`)}</small>}</Show>
    </Show>,
  }
}

export function MissionRecoveryButton(props: MissionRecoveryButtonProps) {
  const { t } = useI18n()
  const recovery = createMissionRecoveryAction(props)
  return <Show when={recovery.action()}>
    {action =>
    <span class="inline-flex items-center gap-1">
      <button type="button" class="mission-control-icon-button" aria-label={action().label} title={action().label}
        aria-busy={action().description === t("missions.recovery.pending")} aria-description={action().description}
        disabled={action().disabled} onClick={() => void action().onSelect()}>
        {action().icon}
      </button>
      {recovery.feedback}
    </span>
    }
  </Show>
}
