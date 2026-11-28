import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { missionCreationChoices, missionCreationChoicesSchema, missionCreationDefaultsSchema, missionCreationTemplateSchema, sameMissionCreationChoices } from "./creation-defaults"
import type { MissionPrepareRequest } from "./control-types"
import type { MissionDocument } from "./mission-document"
import { missionRecoveryControlError } from "./recovery-error"
import { automaticMissionStartID } from "./preparation-result"
import { stableToken } from "./receipt-identity"
import { documentID, missionCriteriaLaunchPolicySchema, nativeDocumentID, requiresMissionCalendar } from "./launch-policy"
import { criteriaLaunchPolicyWire } from "./mission-document-wire"

export const missionPreparationOptionsSchema = z.object({
  launch: missionCriteriaLaunchPolicySchema.optional(),
  watchedConversationIDs: z.array(nativeDocumentID).max(64).refine(ids => new Set(ids).size === ids.length).optional(),
  coordinatorSessionID: nativeDocumentID.optional(),
  coordinatorGoal: z.boolean().optional(),
})
export type MissionPreparationOptions = z.infer<typeof missionPreparationOptionsSchema>
export const preparationAuthorSchema = z.object({ coordinatorSessionID: nativeDocumentID, missionID: documentID.optional() }).strict()
export type PreparationAuthor = z.infer<typeof preparationAuthorSchema>
export const missionPreparationInputSchema = missionCreationChoicesSchema.extend({
  objective: z.string().min(1).max(20_000), title: z.string().min(1).max(60).optional(),
  notes: z.string().max(20_000).optional(), template: missionCreationTemplateSchema,
  startOnCreation: z.boolean(), ...missionPreparationOptionsSchema.shape,
}).strict()
export const missionPreparationCreationSchema = z.object({
  requestID: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/),
  author: preparationAuthorSchema.optional(), input: missionPreparationInputSchema.optional(),
  creationDefaults: missionCreationDefaultsSchema.optional(),
  automaticStart: z.object({ requestID: z.string().min(1).max(128), attempted: z.boolean() }).strict().optional(),
}).strict()

/** Equivalent immediate selectors and unordered followed sources share a retry identity. */
export function normalizedPreparationOptions(input: MissionPreparationOptions) {
  const parsed = missionPreparationOptionsSchema.parse(input)
  return { kind: parsed.launch && requiresMissionCalendar(parsed.launch) ? "schedule" as const : "one-time" as const,
    ...(parsed.launch && requiresMissionCalendar(parsed.launch) ? { launch: parsed.launch } : {}),
    watchedConversationIDs: [...parsed.watchedConversationIDs ?? []].sort(),
    ...(parsed.coordinatorSessionID === undefined ? {} : { coordinatorSessionID: parsed.coordinatorSessionID }),
    ...(parsed.coordinatorGoal ? { coordinatorGoal: true as const } : {}) }
}
export const samePreparationOptions = (left: MissionPreparationOptions, right: MissionPreparationOptions) =>
  canonicalAuthority(normalizedPreparationOptions(left)) === canonicalAuthority(normalizedPreparationOptions(right))

/** A retried preparation names the stored one: same author, request and inputs. */
export function assertSamePreparation(doc: MissionDocument, author: PreparationAuthor, requestID: string, input: MissionPrepareRequest) {
  const creation = doc.creation, original = creation?.input
  if (!creation || creation.requestID !== requestID || !original
    || canonicalAuthority(creation.author) !== canonicalAuthority(author)
    || original.objective !== input.objective || original.title !== input.title || original.notes !== input.notes
    || original.template !== input.template || original.startOnCreation !== Boolean(input.startOnCreation)
    || !samePreparationOptions(original, input)
    || !sameMissionCreationChoices(creation.creationDefaults?.request ?? original, input)) throw missionRecoveryControlError("prepare-conflict")
}

export function missionPreparationCreation(input: MissionPrepareRequest, author: PreparationAuthor, requestID: string) {
  const { kind: _kind, ...options } = normalizedPreparationOptions(input)
  const original = missionPreparationInputSchema.parse({ objective: input.objective, template: input.template,
    ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...missionCreationChoices(input.creationDefaults?.request ?? input), ...options, startOnCreation: input.startOnCreation === true })
  return missionPreparationCreationSchema.parse({ requestID, author, input: original,
    digest: stableToken(canonicalAuthority({ author, input: original, creationDefaults: input.creationDefaults ?? null }), 64),
    ...(input.creationDefaults ? { creationDefaults: input.creationDefaults } : {}),
    ...(input.startOnCreation ? { automaticStart: { requestID: automaticMissionStartID(requestID), attempted: false } } : {}) })
}

const text = { type: "string" } as const
export const missionPreparationOptionsWire = {
  launch: criteriaLaunchPolicyWire,
  watchedConversationIDs: { type: "array", maxItems: 64, uniqueItems: true, items: text },
  coordinatorSessionID: text,
  coordinatorGoal: { type: "boolean" },
} as const
