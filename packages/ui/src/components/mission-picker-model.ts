import type { RecurrenceSchedule } from "../stores/mission-recurrence"
import type { UnifiedMissionSchedule } from "../stores/mission-schedules"

/** Colour carries attention; the waiting underline and pause/warning shapes
 * distinguish states independently of the palette's accent contrast. */
export type MissionMark = "permission" | "interrupted" | "working" | "paused" | "done" | "prepared" | "waiting" | "unconfirmed" | "idle"

export interface MissionPickerEntry {
  /** `mission:<id>` or `schedule:<id>`. */
  key: string
  title: string
  /** Full localized state for tooltips and screen readers. */
  status: string
  mark: MissionMark
  /** The most urgent state of a Mission's tasks, carried by its chevron like a
   * session's children: a task asks for an answer, works, or finished unseen. */
  childActivity?: "permission" | "working" | "idle"
  /** A Mission whose plan holds no task: like a session without children, no chevron. */
  leaf?: boolean
}

/** A one-time Mission's own state from native requests and observed actor activity:
 * red only for the questions its flag carries (`openRequests`, each one it can
 * open); observed actor states, the coordinator's included, cover whole families
 * and never redden it. Its tasks' questions belong to its chevron.
 * A failed mission can be resumed unless the user stopped it since, so it reads
 * as interrupted; a completed one is green until seen. */
export function missionMark(mission: { status: string; runState?: string }, input: {
  openRequests: number; actorStates?: readonly string[]; coordinatorState?: string; seen: boolean
}): MissionMark {
  const states = input.actorStates ?? []
  if (input.openRequests > 0) return "permission"
  const run = mission.runState ?? "running"
  if (mission.status === "failed") return run === "running" ? "interrupted" : "idle"
  if (mission.status === "completed") return input.seen ? "idle" : "done"
  if (mission.status !== "active") return "idle"
  if (run === "paused") return "paused"
  if (run === "prepared") return "prepared"
  if (run !== "running") return "idle"
  if (states.some(state => state === "running" || state === "queued" || state === "background")) return "working"
  return input.coordinatorState === "idle-without-report" ? "interrupted" : "idle"
}

interface ScheduleMarkFacts {
  state: string; prepared: boolean; uncertain: boolean; interrupted: boolean
  pending: boolean; waiting: boolean; outcome?: string
}
/** Both document adapters use the same priority, including Pause over pending work.
 * Only a positive native observation can supply waiting or working. */
function projectScheduleMark(facts: ScheduleMarkFacts, openRequests: number, seen: boolean): MissionMark {
  if (openRequests) return "permission"
  if (facts.state === "stopped") return "idle"
  if (facts.interrupted) return "interrupted"
  if (facts.uncertain) return "unconfirmed"
  if (facts.prepared) return "prepared"
  if (facts.state === "paused") return "paused"
  if (facts.pending) return "working"
  if (facts.outcome === "failed" || facts.outcome === "ended-without-report") return "interrupted"
  if (facts.outcome === "completed" && !seen) return "done"
  return facts.waiting ? "waiting" : "idle"
}

export function scheduleMark(schedule: RecurrenceSchedule, openRequests = 0, seen = true, fresh = true, now = Date.now()): MissionMark {
  return projectScheduleMark({ state: schedule.state, prepared: false,
    interrupted: schedule.state === "interrupted" || schedule.state === "running" && !schedule.pending
      && (schedule.latestResult?.outcome === "failed" || schedule.latestResult?.outcome === "ended-without-report"),
    uncertain: !fresh || schedule.controls.some(control => !control.controlsComplete) || Boolean(schedule.lastError)
      || schedule.state !== "paused" && (schedule.pending?.status === "uncertain"
      || schedule.state === "running" && !schedule.pending && !(schedule.nextDueAt !== null && schedule.nextDueAt > now)),
    pending: schedule.state !== "paused" && Boolean(schedule.pending),
    waiting: schedule.state === "running" && schedule.nextDueAt !== null && schedule.nextDueAt > now,
    outcome: schedule.latestResult?.outcome }, openRequests, seen)
}

export function unifiedScheduleMark(doc: UnifiedMissionSchedule, openRequests = 0, seen = true, fresh = true, now = Date.now()): MissionMark {
  const prepared = doc.firstPlayedAt === null && doc.state === "paused"
  const observed = doc.observation.state === "known" && doc.observation.timeGeneration === doc.timeGeneration
  const failure = Boolean(doc.blockReason && ["failed", "ended-without-report"].includes(doc.blockReason))
    || doc.state !== "paused" && !doc.pendingPassage && Boolean(doc.latestResult && doc.latestResult.outcome !== "completed")
  const waiting = observed && doc.state === "running" && (doc.observation.nativeStatus === "active" || doc.observation.nativeStatus === "mixed")
    && doc.observation.nextDueAt !== null && doc.observation.nextDueAt > now
  const uncertain = !fresh || Boolean(doc.control?.pending) || Boolean(doc.blockReason && !failure)
    || !prepared && (doc.observation.state === "unknown" || doc.observation.timeGeneration !== doc.timeGeneration
      || doc.state === "running" && !doc.pendingPassage && !waiting)
  return projectScheduleMark({ state: doc.state, prepared, interrupted: Boolean(failure),
    uncertain, pending: doc.state !== "paused" && Boolean(doc.pendingPassage),
    waiting,
    outcome: doc.latestResult?.outcome }, openRequests, seen)
}

export function missionMarkStateKey(mark: MissionMark): string | undefined {
  return mark === "waiting" ? "missionsPanel.state.waiting" : mark === "done" ? "missionsPanel.state.unreadSuccess"
    : mark === "unconfirmed" ? "missionsPanel.state.unconfirmed" : mark === "prepared" ? "missions.control.run.prepared"
    : mark === "interrupted" ? "missionsPanel.state.interrupted" : undefined
}

export function filterMissionPickerEntries(entries: readonly MissionPickerEntry[], query: string): MissionPickerEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? entries.filter(entry => entry.title.toLocaleLowerCase().includes(needle)) : [...entries]
}
