import { createSignal } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionProfileDefault, MissionTaskMode } from "../lib/mission-defaults"
import type { UserMissionModel } from "../lib/mission-model-library"

/** What an idle editor left behind when its panel unmounted. */
export interface MissionEditorDraft {
  scheduling?: import("../components/mission-scheduling-data").MissionSchedulingDraft
  previousDraft?: string
  journalMission?: MissionPanelMap
  mode: "once" | "recurring"; titleOverride?: string; time: string; zone: string; watched: string[]
  objective: string; notes: string; template: MissionPanelMap["template"]; profiles?: MissionProfiles; customProfiles: boolean
  taskMode?: MissionTaskMode; customTaskMode: boolean; defaults: MissionProfileDefault[]; defaultsReady: boolean
  draftId?: string
  selectedModel?: UserMissionModel; savedBaselines?: UserMissionModel[]; optionsOpen: boolean; profileDetailsOpen: boolean
  startOnCreation?: boolean
  coordinatorGoal?: boolean
  coordinatorSessionID?: string
  /** The programming a recurring creation saves: the same one however often the form is submitted. */
  calendarID?: string
  requestId: string; lastPayload: string; deleteManagedSessions: boolean; deleteAttempted: boolean
  deleteAutoSubmitted?: boolean; deleteError?: string
}

/** `calendar`: the creation form edits this existing programmed Mission. */
export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionPanelMap; calendar?: string; draft?: Readonly<MissionEditorDraft> }

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

const draftBaselineListeners = new Map<string, (saved: UserMissionModel) => void>()

export function registerMissionDraftBaseline(draftId: string, onBaseline: (saved: UserMissionModel) => void): () => void {
  draftBaselineListeners.set(draftId, onBaseline)
  return () => { if (draftBaselineListeners.get(draftId) === onBaseline) draftBaselineListeners.delete(draftId) }
}

/** Record a confirmed saved-configuration baseline on the exact originating draft (mounted or awaiting remount). */
export function recordMissionDraftBaseline(draftId: string, saved: UserMissionModel) {
  const listener = draftBaselineListeners.get(draftId)
  if (listener) { listener(saved); return }
  setEditors(current => {
    const entry = [...current].find(([, value]) => value.draft?.draftId === draftId)
    if (!entry) return current
    const [scope, action] = entry, draft = action.draft!
    const savedBaselines = [...(draft.savedBaselines ?? []).filter(item => item.id !== saved.id), saved]
    const selectedModel = draft.selectedModel?.id === saved.id ? saved : draft.selectedModel
    return new Map(current).set(scope, { ...action, draft: { ...draft, savedBaselines, selectedModel } })
  })
}
