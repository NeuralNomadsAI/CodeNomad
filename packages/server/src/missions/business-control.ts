import type { MissionControl } from "./control"
import type { MissionMap } from "./model"
import { z } from "zod"
import { parseDelegateInput, parseInspectInput, parseReportInput, parseReviseInput } from "../opencode/missions-plugin"
import { normalizeTaskDeclaration, taskContractReferenceSchema } from "./task-declaration"
import { parseMissionBriefingRequest } from "./briefing"

export const missionBusinessMethods = ["listMissions", "inspect", "delegate", "declare", "revise", "report", "reportNative", "briefing",
  "interruptTask", "prepare", "contextFor", "observeTask", "decisionCandidates"] as const
export type MissionBusinessMethod = typeof missionBusinessMethods[number]
type Mutation = "delegate" | "declare" | "revise" | "report" | "reportNative" | "briefing" | "prepare"
/** Mutations return only the affected tasks. Full inspection remains explicit. */
export type MissionBusinessMutationMap = Pick<MissionMap, "id" | "title" | "objective" | "template" | "taskMode" | "revision" | "status" | "runState" | "frontier" | "tasks">
type MutationResult<K extends Mutation> = Omit<Awaited<ReturnType<MissionControl[K]>>, "mission"> & { mission: MissionBusinessMutationMap }
export type MissionBusinessControl = Pick<MissionControl, Exclude<MissionBusinessMethod, Mutation | "inspect"> | "backendActions"> & {
  [K in Mutation]: (...args: Parameters<MissionControl[K]>) => Promise<MutationResult<K>>
} & { inspect(...args: Parameters<MissionControl["inspect"]>): Promise<Omit<Awaited<ReturnType<MissionControl["inspect"]>>, "mission"> & {
  mission: MissionBusinessMutationMap | null
}> }

const mutations = new Set<string>(["delegate", "declare", "revise", "report", "reportNative", "briefing", "prepare"])
const session = z.string().regex(/^ses_/).max(240)
const text = z.string().min(1).max(240)
const taskKey = taskContractReferenceSchema.shape.taskKey

/** Fixed method parsing and caller binding precede every property invocation.
 * Reads use the verified root; mutations preserve the actual native caller. */
export function missionBusinessCall(method: MissionBusinessMethod, args: readonly unknown[], callerID: string, rootID: string, missionID: string) {
  const rootRead = ["listMissions", "inspect", "contextFor", "observeTask", "decisionCandidates"].includes(method)
  const principal = rootRead ? rootID : callerID
  const scope = <T extends { missionID?: string }>(input: T): T => {
    if (input.missionID !== undefined && input.missionID !== missionID) throw new Error("Foreign Mission business selector")
    return { ...input, missionID }
  }
  const arity = (count: number) => { if (args.length !== count) throw new Error("Invalid Mission business arguments") }
  const bound = () => { if (session.parse(args[0]) !== principal) throw new Error("Foreign Mission business caller") }
  switch (method) {
    case "listMissions":
      arity(1); bound()
      return { tool: { name: "inspect" as const, input: { missionID } }, invoke: (control: MissionControl) => control.listMissions(rootID) }
    case "contextFor":
      arity(1); bound()
      return { tool: { name: "inspect" as const, input: { missionID } }, invoke: (control: MissionControl) => control.contextFor(rootID) }
    case "inspect": {
      arity(3); bound()
      const input = scope(parseInspectInput(args[1])), operationID = text.parse(args[2])
      if (input.start || input.list) throw new Error("Scheduled Mission creation unavailable")
      return { tool: { name: "inspect" as const, input }, invoke: (control: MissionControl) => control.inspect(rootID, input, operationID) }
    }
    case "declare": {
      arity(2); bound()
      const input = scope(normalizeTaskDeclaration(args[1]))
      return { tool: { name: "declare" as const, input }, invoke: (control: MissionControl) => control.declare(callerID, input) }
    }
    case "delegate": {
      arity(2); bound()
      const input = scope(parseDelegateInput(args[1]))
      if (input.executionMode?.kind !== "independent") throw new Error("Independent Mission execution requires its explicit reason")
      return { tool: { name: "delegate" as const, input }, targetSessionID: input.targetSessionID,
        invoke: (control: MissionControl) => control.delegate(callerID, input) }
    }
    case "revise": {
      arity(2); bound()
      const input = scope(parseReviseInput(args[1]))
      return { tool: { name: "revise" as const, input }, invoke: (control: MissionControl) => control.revise(callerID, input) }
    }
    case "report": {
      arity(2); bound()
      const input = scope(parseReportInput(args[1]))
      return { tool: { name: "report" as const, input }, invoke: (control: MissionControl) => control.report(callerID, input) }
    }
    case "reportNative": {
      arity(2)
      const request = z.object({ contract: taskContractReferenceSchema, sessionID: session, toolCallID: text, messageID: text }).strict().parse(args[0])
      if (request.sessionID !== callerID || request.contract.missionID !== missionID) throw new Error("Foreign native report caller")
      const input = scope(parseReportInput(args[1]))
      return { tool: { name: "report" as const, input: { ...input, contract: request.contract } },
        invoke: (control: MissionControl) => control.reportNative(request, input) }
    }
    case "briefing": {
      arity(2); bound()
      const input = scope(parseMissionBriefingRequest(args[1]))
      return { tool: { name: "briefing" as const, input }, invoke: (control: MissionControl) => control.briefing(callerID, input) }
    }
    case "observeTask": case "decisionCandidates": {
      arity(3); bound()
      const selectedMission = args[1] === null || args[1] === undefined ? undefined : text.max(100).parse(args[1])
      scope({ missionID: selectedMission })
      const key = taskKey.parse(args[2])
      return { tool: { name: "inspect" as const, input: { missionID: selectedMission, taskKey: key } }, invoke: (control: MissionControl) =>
        method === "observeTask" ? control.observeTask(rootID, selectedMission, key) : control.decisionCandidates(rootID, selectedMission, key) }
    }
    case "interruptTask": case "prepare": throw new Error("Scheduled Mission backend actions unavailable")
    default: throw new Error("Unsupported Mission business method")
  }
}
/** This projection precedes RPC serialization, matching what the model-facing
 * tool actually uses instead of copying a whole journal after every write. */
export function missionBusinessResult(method: MissionBusinessMethod, args: readonly unknown[], value: unknown): unknown {
  const input = args[1] as { taskKey?: string; addTasks?: Array<{ taskKey: string }>; retireTasks?: Array<{ taskKey: string }>;
    dependencyUpdates?: Array<{ taskKey: string }> } | undefined
  if (!mutations.has(method) && !(method === "inspect" && input?.taskKey)) return value
  if (!value || typeof value !== "object" || !("mission" in value) || !value.mission) return value
  const result = value as { mission: MissionMap; taskKey?: string; contract?: { taskKey?: string } }
  const mission = result.mission
  const keys = new Set([result.taskKey, result.contract?.taskKey, input?.taskKey,
    ...(input?.addTasks ?? []).map(task => task.taskKey), ...(input?.retireTasks ?? []).map(task => task.taskKey),
    ...(input?.dependencyUpdates ?? []).map(task => task.taskKey)].filter((key): key is string => !!key))
  return { ...result, mission: { id: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }),
    objective: mission.objective, template: mission.template, ...(mission.taskMode === undefined ? {} : { taskMode: mission.taskMode }),
    revision: mission.revision, status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    frontier: mission.frontier, tasks: mission.tasks.filter(task => keys.has(task.key)) } }
}
