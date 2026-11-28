import { Context, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"

export const missionAutomationService = Context.Service<never, unknown>("@opencode/Automation")

export const missionAutomationInfo = Schema.toType(Automation.Info)
export const readMissionAutomation = Schema.decodeUnknownEffect(missionAutomationInfo)
