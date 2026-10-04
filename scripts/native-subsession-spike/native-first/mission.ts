import { MissionJournal, stableToken } from "../../../packages/server/src/missions/journal.ts"
import { validateMissionReportArtifact } from "../../../packages/server/src/missions/contracts.ts"
import { reportAdmissionID, reportNotificationID } from "../../../packages/server/src/missions/receipt-identity.ts"

const prefix = "native-first-experiment/"
const base = (ctx: any, missionID: string, id: string) => ({ version: 1, id, missionID, projectID: ctx.location.project.id, createdAt: Date.now() })
const journal = (ctx: any) => new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical)

// Research interface only: no dispatch, scheduler, native tool replacement, or desktop activation.
export async function start(ctx: any, sessionID: string, input: { objective: string; tasks: string[] }) {
  const root = await ctx.session.get({ sessionID })
  if (root.parentID || root.projectID !== ctx.location.project.id || root.location.directory !== ctx.location.directory) throw new Error("Owned root required")
  if (!input.objective?.trim() || input.objective.length > 20000 || !Array.isArray(input.tasks) || input.tasks.length > 32
    || input.tasks.some(key => !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(key)) || new Set(input.tasks).size !== input.tasks.length) throw new Error("Invalid root contract")
  if (await ctx.storage.get(prefix + sessionID)) throw new Error("Root already contracted")
  const missionID = "msn_" + stableToken(sessionID, 24)
  await journal(ctx).append({ ...base(ctx, missionID, "created_" + stableToken(sessionID, 24)), type: "mission.created",
    projectCanonical: ctx.location.project.canonical, objective: input.objective, template: "custom",
    coordinator: { sessionID, title: root.title, location: root.location } })
  for (const key of input.tasks) await journal(ctx).append({ ...base(ctx, missionID, "task_" + key), type: "task.created",
    task: { id: "tsk_" + key, key, title: key, brief: input.objective, role: "research", blockedBy: [] } })
  const contract = { missionID, coordinatorID: sessionID, tasks: input.tasks }
  await ctx.storage.set(prefix + sessionID, contract)
  return contract
}

export async function record(ctx: any, sessionID: string) {
  const lineage: any[] = [], seen = new Set<string>()
  let id = sessionID
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(id)) throw new Error("Native ancestry cycle")
    seen.add(id)
    const session = await ctx.session.get({ sessionID: id })
    if (session.projectID !== ctx.location.project.id || session.location.directory !== ctx.location.directory) throw new Error("Native ancestry outside owned Location")
    if (!session.parentID) {
      const contract = await ctx.storage.get(prefix + id)
      return contract ? { ...contract, sessionID, lineage } : undefined
    }
    const page = await ctx.storage.scan({ prefix: "native-first-call/" + id + "/", limit: 100 })
    if (page.next) throw new Error("Native call correlation exceeds bounded read")
    const calls = page.entries.map((entry: any) => entry.value).filter((call: any) => call.parentID === session.parentID)
    // Continuation adds calls to the same child; keep every structured native call, never infer from prompt/title/output.
    lineage.push({ childID: id, parentID: session.parentID, callIDs: calls.map((call: any) => call.callID) })
    id = session.parentID
  }
  throw new Error("Native ancestry exceeds experiment depth ceiling")
}

export async function report(ctx: any, tool: any, input: { taskKey: string; outcome: "completed" | "blocked" | "failed"; summary: string }) {
  const binding = await record(ctx, tool.sessionID)
  if (!binding || !binding.tasks.includes(input.taskKey)) throw new Error("No inherited task contract")
  if (!binding.lineage.length) throw new Error("This experiment reports descendant tasks, not coordinator completion")
  if (!["completed", "blocked", "failed"].includes(input.outcome) || !input.summary?.trim() || input.summary.length > 20000) throw new Error("Invalid report")
  if (binding.lineage.some((edge: any) => edge.callIDs.length === 0)) throw new Error("Native call correlation unavailable")
  validateMissionReportArtifact({ template: "custom", role: "research", outcome: input.outcome })
  const id = "rep_" + stableToken(tool.sessionID + "\0" + tool.id, 24)
  const store = journal(ctx)
  const task = (await store.snapshot()).missions.find(m => m.id === binding.missionID)?.tasks.find(t => t.key === input.taskKey)
  if (!task || (task.actorSessionId && task.actorSessionId !== tool.sessionID)) throw new Error("Task already belongs to another native actor")
  if (!task.actorSessionId) {
    const admission = await ctx.storage.get("native-first-admission/" + tool.sessionID)
    if (!admission) throw new Error("Native prompt admission correlation unavailable")
    const session = await ctx.session.get({ sessionID: tool.sessionID })
    // Existing journal vocabulary records a past native admission; it does not perform or enqueue execution.
    await store.append({ ...base(ctx, binding.missionID, "binding_" + stableToken(id, 24)), createdAt: admission.createdAt,
      type: "task.dispatching", taskKey: input.taskKey, actor: { sessionID: tool.sessionID, title: session.title, location: session.location, managed: false },
      admissionID: admission.id, delivery: admission.delivery })
  }
  const value = { id, taskKey: input.taskKey, sessionId: tool.sessionID, outcome: input.outcome, summary: input.summary,
    evidence: [], next: [], artifact: { nativeCallID: tool.id, lineage: binding.lineage }, createdAt: Date.now() }
  await store.append({ ...base(ctx, binding.missionID, id), type: "task.reported", report: value })
  // ponytail: storage then synthetic, not atomic; a durable outbox is needed before production crash guarantees.
  const messageID = reportAdmissionID(id)
  await ctx.session.synthetic({ sessionID: binding.coordinatorID, id: messageID, text: "NATIVE_FIRST_REPORT:" + JSON.stringify(value),
    metadata: { "native-first.report": value }, resume: true, delivery: "queue" })
  await store.append({ ...base(ctx, binding.missionID, reportNotificationID(binding.missionID, id)), type: "report.notified", reportID: id, admissionID: messageID })
  return { report: value, messageID }
}
