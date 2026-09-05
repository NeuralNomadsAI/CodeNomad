import { z } from "zod"

import type { MissionActor, MissionJsonValue, MissionReportOutcome, MissionTask, MissionTemplateId } from "./model"

const DiagnosisArtifact = z.object({
  kind: z.literal("diagnosis"),
  feedbackLoop: z.object({ command: z.string().min(1), redOutput: z.string().min(1) }),
  minimizedRepro: z.string().min(1),
  confirmedHypothesis: z.string().min(1),
  evidence: z.string().min(1),
  rejectedHypotheses: z.array(z.string()).max(20),
})

const FixArtifact = z.object({
  kind: z.literal("fix"),
  changedFiles: z.array(z.string()).max(200),
  regressionTest: z.discriminatedUnion("seam", [
    z.object({
      seam: z.literal("present"),
      path: z.string().min(1),
      command: z.string().min(1),
      redObserved: z.literal(true),
      greenObserved: z.literal(true),
    }),
    z.object({ seam: z.literal("absent"), absenceReason: z.string().min(1) }),
  ]),
  originalLoopGreen: z.literal(true),
  debugInstrumentationRemoved: z.literal(true),
  prevention: z.string().min(1),
})

const ReviewFinding = z.object({
  id: z.string().min(1),
  severity: z.enum(["hard", "judgement"]),
  file: z.string().optional(),
  message: z.string().min(1),
  evidence: z.string().min(1),
})

const reviewArtifact = (axis: "standards" | "spec") => z.object({
  kind: z.literal("review"),
  axis: z.literal(axis),
  verdict: z.enum(["pass", "changes-required"]),
  findings: z.array(ReviewFinding).max(50),
})

const ResolutionArtifact = z.object({
  kind: z.literal("resolution"),
  addressed: z.array(z.string()).max(50),
  deferred: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })).max(50),
  focusedChecks: z.array(z.object({ command: z.string().min(1), passed: z.boolean() })).max(50),
})

const ValidationArtifact = z.object({
  kind: z.literal("validation"),
  checks: z.array(z.object({
    kind: z.enum(["typecheck", "lint", "test", "build"]),
    command: z.string(),
    status: z.enum(["passed", "failed", "not-configured"]),
    summary: z.string(),
  })).max(50),
  focusedRegression: z.object({
    command: z.string().min(1),
    status: z.literal("passed"),
    summary: z.string().min(1),
  }),
  verdict: z.literal("green"),
}).superRefine((result, context) => {
  for (const kind of ["typecheck", "lint", "test", "build"] as const) {
    if (!result.checks.some((check) => check.kind === kind)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: `${kind} must be reported` })
    }
  }
  if (result.checks.some((check) => check.status === "failed")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "A failed check cannot produce a green verdict" })
  }
})

const pocockContracts: Record<string, z.ZodTypeAny> = {
  diagnostician: DiagnosisArtifact,
  implementer: FixArtifact,
  "review-standards": reviewArtifact("standards"),
  "review-spec": reviewArtifact("spec"),
  resolver: ResolutionArtifact,
  validator: ValidationArtifact,
}

const pocockPrerequisites: Record<string, string[]> = {
  diagnostician: [],
  implementer: ["diagnostician"],
  "review-standards": ["implementer"],
  "review-spec": ["implementer"],
  resolver: ["review-standards", "review-spec"],
  validator: ["resolver"],
}

export function validateMissionDelegationPolicy(input: {
  template: MissionTemplateId
  role: string
  targetSessionID?: string
  actors: readonly MissionActor[]
  tasks: readonly Pick<MissionTask, "role" | "status">[]
}): void {
  if (input.template === "custom") return
  const roles = input.template === "pocock-fix-bug"
    ? Object.keys(pocockContracts)
    : ["cartographer", "research", "prototype", "grilling", "decision"]
  if (!roles.includes(input.role)) throw new Error(`${input.role} is not a ${input.template} playbook role`)
  if (input.template !== "pocock-fix-bug") return
  if (["review-standards", "review-spec", "validator"].includes(input.role) && input.targetSessionID) {
    throw new Error(`The Pocock ${input.role} role requires a fresh root session`)
  }
  if (input.role === "resolver") {
    const implementer = input.actors.find((actor) => actor.roles.includes("implementer"))
    if (!input.targetSessionID || input.targetSessionID !== implementer?.sessionId) {
      throw new Error("The Pocock resolver must reuse the implementer root session")
    }
  }
  const missing = pocockPrerequisites[input.role]?.find((role) => !input.tasks.some((task) => task.role === role && task.status === "completed"))
  if (missing) {
    throw new Error(`The Pocock ${input.role} role requires completed ${missing} evidence`)
  }
}

export function validateMissionCompletionPolicy(input: {
  template: MissionTemplateId
  outcome: "completed" | "failed"
  tasks: readonly Pick<MissionTask, "role" | "status">[]
}): void {
  if (input.template !== "pocock-fix-bug" || input.outcome !== "completed") return
  const missing = Object.keys(pocockContracts)
    .find((role) => !input.tasks.some((task) => task.role === role && task.status === "completed"))
  if (missing) throw new Error(`A green Pocock mission requires completed ${missing} evidence`)
}

export function validateMissionReportArtifact(input: {
  template: MissionTemplateId
  role: string
  outcome: MissionReportOutcome
  artifact?: MissionJsonValue
}): MissionJsonValue | undefined {
  if (input.template !== "pocock-fix-bug" || input.outcome !== "completed") return input.artifact
  const contract = pocockContracts[input.role]
  if (!contract) throw new Error(`The Pocock role ${input.role} has no report contract`)
  const result = contract.safeParse(input.artifact)
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "artifact"}: ${issue.message}`).join("; ")
    throw new Error(`Pocock ${input.role} report contract failed: ${detail}`)
  }
  return result.data as MissionJsonValue
}
