import { createSignal } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionProfileDefault, MissionTaskMode } from "../lib/mission-defaults"
import type { UserMissionModel } from "../lib/mission-model-library"

/** What an idle editor left behind when its panel unmounted. */
export interface MissionEditorDraft {
  scheduling?: import("../components/mission-scheduling-data").MissionSchedulingDraft
  scheduleDocument?: NonNullable<import("../../../server/src/api-types").MissionScheduleRead["document"]>
  scheduleAnchorAt?: number; previousDraft?: string
  journalMission?: MissionPanelMap
  mode: "once" | "recurring"; titleOverride?: string; time: string; zone: string; watched: string[]
  objective: string; notes: string; template: MissionPanelMap["template"]; profiles?: MissionProfiles; customProfiles: boolean
  taskMode?: MissionTaskMode; customTaskMode: boolean; defaults: MissionProfileDefault[]; defaultsReady: boolean
  selectedModel?: Pick<UserMissionModel, "id" | "name">; optionsOpen: boolean; profileDetailsOpen: boolean
  requestId: string; lastPayload: string; deleteManagedSessions: boolean; deleteAttempted: boolean
}

export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionPanelMap; scheduleID?: string; draft?: Readonly<MissionEditorDraft> }

// Window memory only, keyed by panel scope: the open editor outlives the panel
// (another right-panel tab) and a hidden project, never a restart, and never
// enters the identity-only native view layout.
const [editors, setEditors] = createSignal<ReadonlyMap<string, MissionEditorAction>>(new Map())

export const missionEditor = (scope: string) => editors().get(scope)

export function openMissionEditor(scope: string, action: MissionEditorAction) {
  setEditors(current => new Map(current).set(scope, action))
}

/** Replace (`next`) or close exactly this open editor; a closed or newer one is untouched. */
export function settleMissionEditor(action: MissionEditorAction, next?: MissionEditorAction) {
  setEditors(current => {
    const scope = [...current].find(([, value]) => value === action)?.[0]
    if (scope === undefined) return current
    const updated = new Map(current)
    if (next) updated.set(scope, next)
    else updated.delete(scope)
    return updated
  })
}
