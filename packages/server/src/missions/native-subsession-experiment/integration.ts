import { z } from "zod"
import { MissionJournal, stableToken, type MissionStorage } from "../journal"
import { validateMissionCompletionPolicy, validateMissionDelegationPolicy, validateMissionReportArtifact } from "../contracts"
import { reportAdmissionID, reportNotificationID } from "../receipt-identity"
import type { MissionJsonValue, MissionLocation, MissionReportOutcome } from "../model"

// Provisional native-child business seam, never imported by production activation.
export interface IntegrationContext {
  location: { directory: string; project: { id: string; canonical: string } }
  storage: MissionStorage
  session: {
    get(input: { sessionID: string }): Promise<{ id: string; parentID?: string; projectID: string; title: string; location: MissionLocation }>
    synthetic(input: { sessionID: string; id: string; text: string; metadata: Record<string, MissionJsonValue>; resume: boolean; delivery: "queue" }): Promise<unknown>
  }
}
const Contract = z.object({ missionID: z.string(), coordinatorID: z.string() })
const Call = z.object({ childID: z.string(), parentID: z.string(), callID: z.string(), eventID: z.string() })
const Admission = z.object({ id: z.string(), delivery: z.enum(["queue", "steer"]), createdAt: z.number() })
const ReportInput = z.object({ final: z.boolean().optional(), taskKey: z.string().optional(), outcome: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().trim().min(1).max(20000), evidence: z.array(z.string().min(1).max(2000)).max(12).optional() }).strict()
const journal = (ctx: IntegrationContext) => new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical)
const base = (ctx: IntegrationContext, missionID: string, id: string, createdAt = Date.now()) => ({ version: 1 as const, id, missionID, projectID: ctx.location.project.id, createdAt })
const rootKey = (id: string) => "integration-root/" + id

async function owned(ctx: IntegrationContext, sessionID: string) {
  const session = await ctx.session.get({ sessionID })
  if (session.id !== sessionID || session.projectID !== ctx.location.project.id || session.location.directory !== ctx.location.directory) throw new Error("Unowned native session")
  return session
}

export async function start(ctx: IntegrationContext, sessionID: string, objective: string) {
  objective = z.string().trim().min(1).max(20000).parse(objective)
  const root = await owned(ctx, sessionID)
  if (root.parentID || await ctx.storage.get(rootKey(sessionID))) throw new Error("Fresh owned coordinator root required")
  const missionID = "msn_" + stableToken(sessionID, 24), store = journal(ctx)
  await store.append({ ...base(ctx, missionID, "created_" + stableToken(sessionID, 24)), type: "mission.created", projectCanonical: ctx.location.project.canonical,
    objective, template: "custom", coordinator: { sessionID, title: root.title, location: root.location } })
  const tasks = [
    { key: "investigate", role: "research", blockedBy: [] },
    { key: "implement", role: "prototype", blockedBy: ["investigate"] },
    { key: "verify", role: "validator", blockedBy: ["implement"] },
  ]
  for (const task of tasks) {
    validateMissionDelegationPolicy({ template: "custom", role: task.role, blockedBy: task.blockedBy, tasks: [] })
    await store.append({ ...base(ctx, missionID, "task_" + task.key), type: "task.created",
      task: { ...task, id: "tsk_" + task.key, title: task.key, brief: objective } })
  }
  const contract = { missionID, coordinatorID: sessionID }
  await ctx.storage.set(rootKey(sessionID), contract)
  return contract
}

export async function read(ctx: IntegrationContext, sessionID: string) {
  const lineage: Array<{ childID: string; parentID: string; callIDs: string[]; eventIDs: string[] }> = [], seen = new Set<string>()
  let id = sessionID
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(id)) throw new Error("Native ancestry cycle")
    seen.add(id)
    const session = await owned(ctx, id)
    if (!session.parentID) {
      const raw = await ctx.storage.get(rootKey(id))
      if (!raw) return undefined
      const contract = Contract.parse(raw), snapshot = await journal(ctx).snapshot()
      const mission = snapshot.missions.find(m => m.id === contract.missionID)
      if (!mission || mission.coordinatorSessionId !== id || contract.coordinatorID !== id) throw new Error("Damaged inherited contract")
      return { ...contract, sessionID, lineage, mission, snapshot }
    }
    const page = await ctx.storage.scan({ prefix: "integration-call/" + id + "/", limit: 100 })
    if (page.next) throw new Error("Incomplete native call inventory")
    const calls = page.entries.map(entry => Call.parse(entry.value)).filter(call => call.childID === id && call.parentID === session.parentID)
    lineage.push({ childID: id, parentID: session.parentID, callIDs: calls.map(call => call.callID), eventIDs: calls.map(call => call.eventID) })
    id = session.parentID
  }
  throw new Error("Native ancestry exceeds research ceiling")
}

export async function report(ctx: IntegrationContext, tool: { sessionID: string; id: string }, raw: unknown) {
  const input = ReportInput.parse(raw), binding = await read(ctx, tool.sessionID)
  if (!binding || binding.mission.status !== "active") throw new Error("No active inherited Mission contract")
  const store = journal(ctx)
  if (input.final) {
    if (binding.coordinatorID !== tool.sessionID || input.taskKey || input.outcome === "blocked") throw new Error("Only coordinator may explicitly finish")
    if (input.outcome === "completed" && binding.mission.tasks.some(task => task.status !== "completed")) throw new Error("Mission tasks are not all completed")
    validateMissionCompletionPolicy({ template: binding.mission.template, outcome: input.outcome, tasks: binding.mission.tasks })
    const id = "finished_" + stableToken(tool.sessionID + "\0" + tool.id, 24)
    // The currently executing coordinator reports completion; requiring its own terminal session would deadlock this operation.
    await store.append({ ...base(ctx, binding.missionID, id), type: "mission.finished", outcome: input.outcome, summary: input.summary })
    return { missionID: binding.missionID, outcome: input.outcome, businessEventID: id }
  }
  const task = binding.mission.tasks.find(task => task.key === input.taskKey)
  if (!task || !binding.lineage.length) throw new Error("Unknown descendant task report")
  if (task.blockedBy.some(key => binding.mission.tasks.find(dependency => dependency.key === key)?.status !== "completed")) throw new Error("Task dependency is not completed")
  if (task.report || (task.actorSessionId && task.actorSessionId !== tool.sessionID)) throw new Error("Task report identity already owned")
  if (binding.lineage.some(edge => !edge.callIDs.length)) throw new Error("Native invocation correlation is unknown")
  const outcome: MissionReportOutcome = input.outcome
  validateMissionReportArtifact({ template: binding.mission.template, role: task.role, outcome })
  const admission = Admission.parse(await ctx.storage.get("integration-admission/" + tool.sessionID))
  const session = await owned(ctx, tool.sessionID), id = "rep_" + stableToken(tool.sessionID + "\0" + tool.id, 24)
  // Bookkeeping of an observed native prompt; never a dispatch call or execution queue.
  await store.append({ ...base(ctx, binding.missionID, "binding_" + stableToken(id, 24), admission.createdAt), type: "task.dispatching", taskKey: task.key,
    actor: { sessionID: tool.sessionID, title: session.title, location: session.location, managed: false }, admissionID: admission.id, delivery: admission.delivery })
  const value = { id, taskKey: task.key, sessionId: tool.sessionID, outcome, summary: input.summary, evidence: input.evidence ?? [], next: [],
    artifact: { nativeReportCallID: tool.id, nativeAdmissionID: admission.id, lineage: binding.lineage }, createdAt: Date.now() }
  await store.append({ ...base(ctx, binding.missionID, id), type: "task.reported", report: value })
  const messageID = reportAdmissionID(id)
  // ponytail: storage plus synthetic admission is not atomic; qualify a durable outbox before promising crash recovery.
  await ctx.session.synthetic({ sessionID: binding.coordinatorID, id: messageID, text: "INTEGRATION_BUSINESS_REPORT:" + JSON.stringify(value),
    metadata: { "integration.report": value }, resume: true, delivery: "queue" })
  await store.append({ ...base(ctx, binding.missionID, reportNotificationID(binding.missionID, id)), type: "report.notified", reportID: id, admissionID: messageID })
  return { report: value, messageID }
}
