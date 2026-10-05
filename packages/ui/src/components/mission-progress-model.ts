import type { MissionActorActivity, MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"

/** Recorded results, not guesses from titles, prose, ancestry or admission. */
export function missionReports(mission: MissionMap): MissionReport[] {
  const reports = new Map<string, MissionReport>()
  // History copies must not overwrite the reducer's authoritative current copy.
  for (const report of [...mission.reports, ...mission.tasks.flatMap(task => task.lateReports ?? []),
    ...mission.tasks.flatMap(task => task.report ? [task.report] : [])]) reports.set(report.id, report)
  return [...reports.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export function missionTaskReport(_mission: MissionMap, task: MissionTask): MissionReport | undefined {
  // Absence is authoritative too: the historical report list cannot settle new work.
  const report = task.report
  if (!report || report.late || report.taskKey !== task.key || task.replacedByTaskKey) return undefined
  const status = report.outcome === "blocked" ? "needs-input" : report.outcome
  if (task.status !== status) return undefined
  if (report.nativeCall && report.nativeCall.generation !== task.contractGeneration) return undefined
  // A later native call in the same contract does not revoke its business result.
  return report
}

/** Retained source records stay readable without becoming the current result. */
export function missionTaskHistory(mission: MissionMap, task: MissionTask): MissionReport[] {
  const current = missionTaskReport(mission, task)
  return missionReports(mission).filter(report => report.taskKey === task.key && report.id !== current?.id)
}

/** Outcome prose is history unless this is the task's authoritative result. */
export function missionReportIsPrevious(mission: MissionMap, report: MissionReport): boolean {
  if (report.late) return true
  if (!report.taskKey) return false // Explicit mission-wide readout, not a task attempt.
  const task = mission.tasks.find(task => task.key === report.taskKey)
  return !task || missionTaskReport(mission, task)?.id !== report.id
}

export function missionProgress(mission: MissionMap, activity: readonly MissionActorActivity[] = []) {
  const tasks = mission.tasks.filter(task => task.status !== "withdrawn" && !task.replacedByTaskKey)
  const open = tasks.filter(task => task.status !== "completed")
  // Activity observes an owned conversation/family, not consumption of any of
  // its assigned tasks. A completed business result can have a native continuation.
  // Pause/Stop also do not prove these observed conversations have become idle.
  const observed = new Map(activity.map(actor => [actor.sessionId, actor]))
  const activeWorkers = [...new Set(mission.actors.map(actor => actor.sessionId))]
    .filter(id => id !== mission.coordinatorSessionId && id !== "global")
    .flatMap(id => {
      const actor = observed.get(id)
      return actor && ["running", "background"].includes(actor.state) ? [actor] : []
    })
  const blockers = open.filter(task => (task.status === "needs-input" || task.status === "failed")
    && missionTaskReport(mission, task))
  const ready = open.filter(task => ["ready", "dispatching", "queued"].includes(task.status))
  const current = new Set(tasks.flatMap(task => {
    const report = missionTaskReport(mission, task)
    return report ? [report.id] : []
  }))
  // Mission-wide reports must explicitly be taskless and coordinator-authored;
  // unknown task keys/prose are not final results. The actual final summary lives
  // in mission.summary (mission.finished), not in a fabricated task report.
  const latest = missionReports(mission).find(report => !report.late && (current.has(report.id)
    || (report.taskKey === "" && report.sessionId === mission.coordinatorSessionId)))
  return { tasks, open, activeWorkers, blockers, ready, latest,
    completed: tasks.filter(task => task.status === "completed").length,
    coordinatorWorking: activity.some(actor => actor.sessionId === mission.coordinatorSessionId
      && ["running", "background"].includes(actor.state)),
  }
}

/** Collapse prose for an excerpt, never truncate the source held by the reader. */
export function missionExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
