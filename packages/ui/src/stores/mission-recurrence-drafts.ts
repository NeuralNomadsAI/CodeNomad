import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { copyMissionProfiles } from "./mission-creation-drafts"

export interface RecurrenceDraft {
  requestID: string
  instructions: string
  notes?: string
  template: MissionTemplateId
  clock: { time: string; zone: string }
  watchedConversationIDs: string[]
  budgets: { effects: number; nativeCalls: number; inboxMessages: number; publications: number }
  profiles: MissionProfiles
  taskMode: "native" | "independent"
  directory?: string
}

// Unknown writes remain held by the original Location. A list of schedules
// cannot prove which request created one, so refresh never clears this hold.
const held = new Map<string, Readonly<RecurrenceDraft>>()

export function uncertainRecurrence(scope: string) { return held.get(scope) }
export function holdRecurrence(scope: string, draft: RecurrenceDraft) {
  if (!held.has(scope)) held.set(scope, {
    ...draft, clock: { ...draft.clock }, budgets: { ...draft.budgets },
    watchedConversationIDs: [...draft.watchedConversationIDs], profiles: copyMissionProfiles(draft.profiles)!,
  })
}
