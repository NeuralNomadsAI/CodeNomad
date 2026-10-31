import { isDeepStrictEqual } from "node:util"
import { MissionControlError } from "./control-error"
import { coordinatorDecisionArtifact, humanDecisionArtifact,
  type CoordinatorDecisionArtifact, type CoordinatorDecisionProvenance, type HumanDecisionArtifact } from "./decision-artifact"
import type { HumanDecisionMark } from "./human-answer"
import type { MissionMap } from "./model"
import { COORDINATOR_DECISION_SHAPE } from "./recipes"

/** How a coordinator settles a Wayfinder decision task; shared by the refusals below. `tag`: the task's `decisionQuestionTag`. */
function decisionOptions(tag?: string) {
  return `Settle it yourself: when the evidence suffices and the choice is cheap to reverse, pass your own decision as artifact ${COORDINATOR_DECISION_SHAPE}; `
    + `otherwise ask the human from your own conversation with the native question tool, ending the question with ${tag ?? "the task's questionTag"} `
    + "and naming no other decision in it (batch several decisions as separate questions, one tag each), and, "
    + "once they answer in the CodeNomad interface, report the task again (when several answers qualify, pass the one mission.inspect({ taskKey }) lists, unchanged). "
    + "To defer the decision, retire the task with mission.revise and keep the question in the notes."
}

/** Model-facing refusal when a Wayfinder decision cites a human answer whose native question cannot be identified exactly. */
export function decisionInvocationUnavailable(tag?: string) {
  return new MissionControlError("Wayfinder decision evidence unavailable: the cited human answer does not name an exact native question "
    + `asked in this mission for this task. ${decisionOptions(tag)}`, "policy-unqualified")
}

/** Model-facing refusal of a completed decision readout that names neither a coordinator decision nor a human answer. */
export function decisionOutcomeRequired(tag?: string) {
  return new MissionControlError(`Decision outcome required: no answered question qualifies for this decision task yet. ${decisionOptions(tag)}`,
    "policy-unqualified")
}

/** Model-facing refusal of a coordinator-asked answer that is not bound to this exact decision task. */
export function decisionQuestionUnbound(tag: string) {
  return new MissionControlError(`This answer does not settle this decision task: the human must answer a question that ends with ${tag} `
    + `and names no other decision, asked after the task was declared. ${decisionOptions(tag)}`, "policy-unqualified")
}

/** How a completed native Wayfinder decision readout is settled: the coordinator's own
 * decision, accepted as such, or the human's answer proven by its confirmed UI mark. */
export type MissionDecisionProof = { decidedBy: "coordinator" } | { decidedBy: "human"; receipt: HumanDecisionMark }

/** The coordinator's own decision, or undefined when the artifact makes no such claim.
 * A malformed coordinator decision is refused with its exact shape, never read as a human answer. */
export function coordinatorDecision(artifact: unknown): CoordinatorDecisionArtifact | undefined {
  if ((artifact as { decidedBy?: unknown } | undefined)?.decidedBy !== "coordinator") return undefined
  const parsed = coordinatorDecisionArtifact.safeParse(artifact)
  if (!parsed.success) throw new MissionControlError(`A coordinator decision passes artifact ${COORDINATOR_DECISION_SHAPE}`, "invalid-report-contract")
  return parsed.data
}

export type CoordinatorAskedAnswer = HumanDecisionArtifact & { provenance: CoordinatorDecisionProvenance }

/** A human answer to a question the coordinator asked from its own conversation. */
export function coordinatorAskedAnswer(artifact: unknown): CoordinatorAskedAnswer | undefined {
  const parsed = humanDecisionArtifact.safeParse(artifact)
  return parsed.success && parsed.data.provenance.kind === "coordinator-form-answer" ? parsed.data as CoordinatorAskedAnswer : undefined
}

/** Coordinator Form fields already settling another live decision task: one answer settles one decision. */
export function claimedDecisionFields(mission: MissionMap, taskKey: string): Array<{ formID: string; fieldKey: string }> {
  return mission.tasks.flatMap(task => {
    const asked = task.key !== taskKey && task.status !== "withdrawn" ? coordinatorAskedAnswer(task.report?.artifact) : undefined
    return asked ? [{ formID: asked.provenance.formID, fieldKey: asked.provenance.fieldKey }] : []
  })
}

/** The gate's mark must be the exact cited native question, in the expected conversation, with the cited answer. */
export function receiptMatches(receipt: HumanDecisionMark, sessionID: string,
  cited: { formID: string; messageID: string; toolCallID: string; fieldKey: string }, answer: string | string[]): boolean {
  const tool = receipt.form.metadata?.tool as { messageID?: unknown; id?: unknown } | undefined
  return receipt.via === "ui" && receipt.sessionID === sessionID && receipt.formID === cited.formID
    && tool?.messageID === cited.messageID && tool?.id === cited.toolCallID && isDeepStrictEqual(receipt.answer[cited.fieldKey], answer)
}
