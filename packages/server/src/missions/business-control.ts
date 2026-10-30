import type { MissionControl } from "./control"
import { missionMutationToolResult, type MissionMutationMethod, type MissionToolResult } from "./tool-result"
import { z } from "zod"
import { parseDelegateInput, parseInspectInput, parseReportInput, parseReviseInput } from "../opencode/missions-plugin"
import { normalizeTaskDeclaration, taskContractReferenceSchema } from "./task-declaration"
import { parseMissionBriefingRequest } from "./briefing"

export const missionBusinessMethods = ["listMissions", "inspect", "delegate", "declare", "revise", "report", "reportNative", "briefing",
  "interruptTask", "prepare", "contextFor", "observeTask", "decisionCandidates", "inspectTool", "ownedRoot"] as const
export type MissionBusinessMethod = typeof missionBusinessMethods[number]
export type MissionBusinessControl = Pick<MissionControl, Exclude<MissionBusinessMethod, MissionMutationMethod | "ownedRoot"> | "backendActions"> & {
  ownedRoot(...args: Parameters<MissionControl["ownedRoot"]>): Promise<unknown>
} & {
  [K in MissionMutationMethod]: (...args: Parameters<MissionControl[K]>) => Promise<Awaited<ReturnType<MissionControl[K]>> | MissionToolResult>
}

const mutations = new Set<string>(["delegate", "declare", "revise", "report", "reportNative", "briefing"])
const session = z.string().regex(/^ses_/).max(240)
const text = z.string().min(1).max(240)

/** Fixed method parsing and caller binding precede every property invocation.
 * Reads use the verified root; mutations preserve the actual native caller. */
export function missionBusinessCall(method: MissionBusinessMethod, args: readonly unknown[], callerID: string, rootID: string, missionID: string) {
  const rootRead = ["listMissions", "inspect", "inspectTool", "ownedRoot", "contextFor", "observeTask", "decisionCandidates"].includes(method)
  const principal = rootRead ? rootID : callerID
  const scope = <T extends { missionID?: string }>(input: T): T => {
    if (input.missionID !== undefined && input.missionID !== missionID) throw new Error("Foreign Mission business selector")
    return { ...input, missionID }
  }
  const arity = (count: number) => { if (args.length !== count) throw new Error("Invalid Mission business arguments") }
  const bound = () => { if (session.parse(args[0]) !== principal) throw new Error("Foreign Mission business caller") }
  switch (method) {
    case "ownedRoot":
      arity(1); bound()
      return { tool: { name: "inspect" as const, input: { missionID } }, invoke: (control: MissionControl) => control.ownedRoot(rootID) }
    case "inspectTool": {
      arity(4); bound()
      const input = scope(parseInspectInput(args[1])), operationID = text.parse(args[2])
      if (input.start) throw new Error("Scheduled Mission creation unavailable")
      return { tool: { name: "inspect" as const, input }, invoke: (control: MissionControl) => control.inspectTool(rootID, input, operationID, args[3] ?? undefined) }
    }
    case "listMissions": case "inspect": case "observeTask": case "decisionCandidates":
      throw new Error("Scheduled Mission reads require inspectTool")
    case "contextFor":
      arity(1); bound()
      return { tool: { name: "inspect" as const, input: { missionID } }, invoke: (control: MissionControl) => control.contextFor(rootID) }
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
    case "interruptTask": case "prepare": throw new Error("Scheduled Mission backend actions unavailable")
    default: throw new Error("Unsupported Mission business method")
  }
}
/** Fit the exact model result inside the owning invocation, before the RPC wire. */
export function missionBusinessResult(method: MissionBusinessMethod, args: readonly unknown[], value: unknown): unknown {
  if (method === "ownedRoot") return null
  if (!mutations.has(method)) return value
  return { toolResult: missionMutationToolResult(method as MissionMutationMethod,
    args[1] as Parameters<typeof missionMutationToolResult>[1], value as Parameters<typeof missionMutationToolResult>[2]) }
}
