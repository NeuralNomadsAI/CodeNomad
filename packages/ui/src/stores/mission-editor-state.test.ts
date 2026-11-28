import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { UserMissionModel } from "../lib/mission-model-library"
import {
  missionEditor, openMissionEditor, recordMissionDraftBaseline, registerMissionDraftBaseline, settleMissionEditor,
  type MissionEditorAction, type MissionEditorDraft,
} from "./mission-editor-state"

const model = (id: string, name: string, notes = ""): UserMissionModel => ({
  version: 1, id, name, objective: "Objective", notes, template: "custom",
})

const draft = (draftId: string, overrides: Partial<MissionEditorDraft> = {}): MissionEditorDraft => ({
  mode: "once", time: "09:00", zone: "UTC", watched: [], objective: "Objective", notes: "", template: "custom",
  customProfiles: false, customTaskMode: false, defaults: [], defaultsReady: true, optionsOpen: true, profileDetailsOpen: false,
  requestId: "req-1", lastPayload: "", deleteManagedSessions: false, deleteAttempted: false, draftId, ...overrides,
})

describe("Mission editor draft baseline ownership", () => {
  it("routes confirmed baselines to the mounted draft without mutating the editor map", () => {
    const scope = "scope-mounted", action: MissionEditorAction = { kind: "create" }
    openMissionEditor(scope, action)
    const received: UserMissionModel[] = []
    const unregister = registerMissionDraftBaseline("draft-1", saved => received.push(saved))
    const saved = model("00000000-0000-4000-8000-000000000001", "My draft")
    recordMissionDraftBaseline("draft-1", saved)
    assert.deepEqual(received, [saved])
    assert.equal(missionEditor(scope), action, "mounted update preserves action identity without remounting")
    unregister()
    settleMissionEditor(action)
  })

  it("updates an unmounted draft awaiting remount and ignores replaced or closed drafts", () => {
    const scope = "scope-unmounted"
    const initial: MissionEditorAction = { kind: "create", draft: draft("draft-a") }
    openMissionEditor(scope, initial)
    const savedA = model("00000000-0000-4000-8000-000000000002", "My draft", "v1")
    recordMissionDraftBaseline("draft-a", savedA)
    assert.deepEqual(missionEditor(scope)?.draft?.savedBaselines, [savedA])
    // Replacing the draft with a new draftId fences late completions from the earlier draft.
    const replaced: MissionEditorAction = { kind: "create", draft: draft("draft-b") }
    openMissionEditor(scope, replaced)
    recordMissionDraftBaseline("draft-a", { ...savedA, notes: "late" })
    assert.equal(missionEditor(scope)?.draft?.savedBaselines, undefined)
    // Closing the editor ignores late completions as well.
    settleMissionEditor(replaced)
    recordMissionDraftBaseline("draft-b", savedA)
    assert.equal(missionEditor(scope), undefined)
  })
})
