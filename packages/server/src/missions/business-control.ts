import type { MissionControl } from "./control"
import { type MissionMutationMethod, type MissionToolResult } from "./tool-result"

export const missionBusinessMethods = ["listMissions", "inspect", "delegate", "declare", "revise", "report", "reportNative", "briefing",
  "interruptTask", "prepare", "contextFor", "observeTask", "decisionCandidates", "inspectTool", "ownedRoot"] as const
export type MissionBusinessMethod = typeof missionBusinessMethods[number]
export type MissionBusinessControl = Pick<MissionControl, Exclude<MissionBusinessMethod, MissionMutationMethod | "ownedRoot"> | "backendActions"> & {
  ownedRoot(...args: Parameters<MissionControl["ownedRoot"]>): Promise<unknown>
} & {
  [K in MissionMutationMethod]: (...args: Parameters<MissionControl[K]>) => Promise<Awaited<ReturnType<MissionControl[K]>> | MissionToolResult>
}
