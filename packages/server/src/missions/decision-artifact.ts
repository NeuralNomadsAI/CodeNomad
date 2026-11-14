import { z } from "zod"
import type { MissionReport, MissionTask, MissionTemplateId } from "./model"
import { taskContractReferenceSchema } from "./task-contract"

const nativeID = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
const text = z.string().min(1).max(20_000)
const answer = z.union([text, z.array(text).min(1).max(32)])
const fieldKey = z.string().regex(/^q(?:0|[1-9]\d?)$/)

/** The decision task's own conversation asked (decision workers launched before coordinator-asked decisions). */
export const nativeDecisionProvenance = z.object({
  kind: z.literal("native-form-answer"),
  contract: taskContractReferenceSchema,
  nativeCall: z.object({ generation: z.number().int().positive().safe(), parentSessionID: nativeID,
    parentMessageID: nativeID, toolCallID: nativeID }).strict(),
  sessionID: nativeID,
  formID: nativeID,
  messageID: nativeID,
  toolCallID: nativeID,
  fieldKey,
}).strict()
export type NativeDecisionProvenance = z.infer<typeof nativeDecisionProvenance>

/** The coordinator asked from its own conversation; one Form field settles at most one decision task. */
export const coordinatorDecisionProvenance = z.object({
  kind: z.literal("coordinator-form-answer"),
  contract: taskContractReferenceSchema,
  sessionID: nativeID,
  formID: nativeID,
  messageID: nativeID,
  toolCallID: nativeID,
  fieldKey,
}).strict()
export type CoordinatorDecisionProvenance = z.infer<typeof coordinatorDecisionProvenance>

/** A human answer: accepted only with the confirmed UI mark of the cited native question. */
export const humanDecisionArtifact = z.object({
  kind: z.literal("decision"),
  decidedBy: z.literal("human").optional(),
  question: text,
  answer,
  provenance: z.discriminatedUnion("kind", [nativeDecisionProvenance, coordinatorDecisionProvenance]),
}).strict()
export type HumanDecisionArtifact = z.infer<typeof humanDecisionArtifact>

/** The coordinator's own decision: no human claim, so `decision` instead of `answer` and no provenance. */
export const coordinatorDecisionArtifact = z.object({
  kind: z.literal("decision"),
  decidedBy: z.literal("coordinator"),
  question: text,
  decision: text,
  rationale: text,
  alternatives: z.array(text).max(16).optional(),
  reversal: text.optional(),
}).strict()
export type CoordinatorDecisionArtifact = z.infer<typeof coordinatorDecisionArtifact>

/** Whether a report artifact claims who settled a decision (`decidedBy`, or a coordinator-asked question). */
export function claimsDecisionMaker(artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false
  const value = artifact as { decidedBy?: unknown; provenance?: { kind?: unknown } }
  return value.decidedBy !== undefined || value.provenance?.kind === "coordinator-form-answer"
}

/** Who settled a completed native Wayfinder decision task. Only gated reports qualify:
 * the coordinator's readout (its own decision, or a human answer the gate verified)
 * and the decision conversation's native return, which the gate verified too. */
export function missionDecisionMaker(template: MissionTemplateId, task: Pick<MissionTask, "role"> & { executionMode?: { kind: string } } | undefined,
  report: Pick<MissionReport, "outcome" | "delivery" | "artifact">): "human" | "coordinator" | undefined {
  if (template !== "wayfinder" || task?.role !== "decision" || task.executionMode?.kind !== "native" || report.outcome !== "completed") return undefined
  if (report.delivery === "coordinator-readout") {
    if (coordinatorDecisionArtifact.safeParse(report.artifact).success) return "coordinator"
    return humanDecisionArtifact.safeParse(report.artifact).success ? "human" : undefined
  }
  const human = report.delivery === "native-return" ? humanDecisionArtifact.safeParse(report.artifact) : undefined
  return human?.success && human.data.provenance.kind === "native-form-answer" ? "human" : undefined
}
