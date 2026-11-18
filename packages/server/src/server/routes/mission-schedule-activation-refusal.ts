import { NativeScheduleActivationRefused } from "../../opencode/native-schedule-settings-activation"
import { configFileEditorID } from "./config-files"

export function missionScheduleActivationRefusal(error: unknown) {
  if (!(error instanceof NativeScheduleActivationRefused)) return undefined
  const configFileID = error.refusal.path && configFileEditorID(error.refusal.path)
  return { ...error.refusal, openable: Boolean(configFileID), ...(configFileID ? { configFileID } : {}) }
}
