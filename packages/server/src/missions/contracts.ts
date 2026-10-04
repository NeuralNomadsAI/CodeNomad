import { z } from "zod"

import type { MissionJsonValue, MissionReportOutcome, MissionTask, MissionTemplateId, MissionNativeBinding } from "./model"
import { taskContractReferenceSchema, type TaskContractReference } from "./task-declaration"
import { parseNativeBinding, sameNativeCall } from "./native-report-provenance"

const nativeID = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
const decisionAnswer = z.union([z.string().min(1).max(20_000), z.array(z.string().min(1).max(20_000)).min(1).max(32)])
const nativeDecisionProvenance = z.object({
  kind: z.literal("native-form-answer"),
  contract: taskContractReferenceSchema,
  nativeCall: z.object({ generation: z.number().int().positive().safe(), parentSessionID: nativeID,
    parentMessageID: nativeID, toolCallID: nativeID }).strict(),
  sessionID: nativeID,
  formID: nativeID,
  messageID: nativeID,
  toolCallID: nativeID,
  fieldKey: z.string().regex(/^q(?:0|[1-9]\d?)$/),
}).strict()
export type NativeDecisionProvenance = z.infer<typeof nativeDecisionProvenance>
export type NativeDecisionArtifactBinding = { contract: TaskContractReference; call: MissionNativeBinding; sessionID: string }

/** Syntax and exact task/invocation correlation ONLY. Neither model JSON nor
 * this validator authenticates a human producer or qualifies native evidence. */
export function validateNativeDecisionArtifact(input: NativeDecisionArtifactBinding & { artifact?: MissionJsonValue }):
  NativeDecisionProvenance & { question: string; answer: string | string[] } {
  const artifact = z.object({ kind: z.literal("decision"), question: z.string().min(1).max(20_000),
    answer: decisionAnswer, provenance: nativeDecisionProvenance }).strict().parse(input.artifact)
  const provenance = artifact.provenance
  const contract = taskContractReferenceSchema.parse(input.contract)
  if (!parseNativeBinding(input.call) || !sameNativeCall(provenance.nativeCall, input.call)
    || provenance.contract.missionID !== contract.missionID || provenance.contract.taskKey !== contract.taskKey
    || provenance.contract.generation !== contract.generation || input.call.generation !== contract.generation
    || provenance.sessionID !== input.sessionID || provenance.sessionID === input.call.parentSessionID) {
    throw new Error("Native decision provenance does not match the current task invocation")
  }
  return { ...provenance, question: artifact.question, answer: artifact.answer }
}

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

type PolicyTask = Pick<MissionTask, "key" | "role" | "status" | "blockedBy" | "actorSessionId" | "replacedByTaskKey">
  & Partial<Pick<MissionTask, "report">>
type ExecutionMode = NonNullable<MissionTask["executionMode"]>

function dependencyKeys(tasks: readonly PolicyTask[], blockedBy: readonly string[], replacements = false): Set<string> {
  const byKey = new Map(tasks.map(task => [task.key, task]))
  const keys = new Set<string>()
  const visit = (key: string) => {
    if (keys.has(key)) return
    keys.add(key)
    const task = byKey.get(key)
    if (!task) return
    for (const blocker of task.blockedBy) visit(blocker)
    if (replacements && task.replacedByTaskKey) visit(task.replacedByTaskKey)
  }
  for (const key of blockedBy) visit(key)
  return keys
}

export function validateMissionDelegationPolicy(input: {
  template: MissionTemplateId
  role: string
  targetSessionID?: string
  blockedBy?: readonly string[]
  executionMode?: ExecutionMode
  phase?: "declaration" | "admission"
  tasks: readonly PolicyTask[]
}): void {
  if (input.template === "custom" && !input.executionMode && input.phase !== "declaration") return
  const roles = input.template === "pocock-fix-bug"
    ? Object.keys(pocockContracts)
    : ["cartographer", "research", "prototype", "grilling", "decision"]
  if (input.template !== "custom" && !roles.includes(input.role)) throw new Error(`${input.role} is not a ${input.template} playbook role`)
  if (input.executionMode || input.phase === "declaration") {
    const mode = input.executionMode
    const keys = dependencyKeys(input.tasks, input.blockedBy ?? [])
    if ([...(input.blockedBy ?? [])].some(key => !input.tasks.some(task => task.key === key))) {
      throw new Error("A playbook dependency must name an existing task")
    }
    if (mode?.kind === "native") {
      if (mode.parentTaskKey !== null && !input.tasks.some(task => task.key === mode.parentTaskKey && task.status !== "withdrawn")) {
        throw new Error("A native parent must name a live task")
      }
      if (mode.reuseFromTaskKey) {
        const source = input.tasks.find(task => task.key === mode.reuseFromTaskKey)
        if (!source || source.status === "withdrawn" || source.replacedByTaskKey) {
          throw new Error("Native reuse must name an exact live task; it does not require a blockedBy dependency")
        }
      }
    }
    if (input.template !== "pocock-fix-bug") return
    if (["review-standards", "review-spec", "validator"].includes(input.role)
      && (input.targetSessionID || (mode?.kind === "native" && mode.reuseFromTaskKey))) {
      throw new Error(`The Pocock ${input.role} role requires a fresh distinct session`)
    }
    if (input.role === "resolver" && mode?.kind === "native") {
      const implementer = input.tasks.find(task => task.key === mode.reuseFromTaskKey)
      if (!implementer || !keys.has(implementer.key) || implementer.role !== "implementer" || implementer.status === "withdrawn" || implementer.replacedByTaskKey) {
        throw new Error("The native Pocock resolver must explicitly reuse a live dependency-connected implementer task")
      }
      if (input.phase !== "declaration") {
        const sessionID = resolvePocockImplementerSessionID(input.tasks, input.blockedBy ?? [], mode)
        if (!sessionID || input.targetSessionID !== sessionID) {
          throw new Error("The native Pocock resolver must reuse the exact completed implementer child with its report")
        }
        // Current native-ended/returned and authoritative-idle observations belong to admission authority.
        // A completed report or stored actor ID is not an idleness proof.
      }
    }
    const missing = pocockPrerequisites[input.role]?.find(role => !input.tasks.some(task =>
      keys.has(task.key) && task.role === role && task.status !== "withdrawn" && !task.replacedByTaskKey
      && (input.phase === "declaration" || task.status === "completed")))
    if (missing) throw new Error(`The Pocock ${input.role} role requires dependency-connected ${missing} evidence`)
    if (input.phase === "declaration" || mode?.kind === "native") return
    // Explicit independent admission retains the established root reuse/freshness constraints below.
  }
  if (input.template !== "pocock-fix-bug") return
  if (["review-standards", "review-spec", "validator"].includes(input.role) && input.targetSessionID) {
    throw new Error(`The Pocock ${input.role} role requires a fresh root session`)
  }
  if (input.role === "resolver") {
    const implementerSessionID = resolvePocockImplementerSessionID(input.tasks, input.blockedBy ?? [])
    if (!implementerSessionID) {
      throw new Error("The Pocock resolver needs one unambiguous live completed implementer from its review dependencies")
    }
    if (!input.targetSessionID || input.targetSessionID !== implementerSessionID) {
      throw new Error("The Pocock resolver must reuse the live implementer root session")
    }
  }
  const missing = pocockPrerequisites[input.role]?.find((role) => !input.tasks.some((task) => task.role === role && task.status === "completed"))
  if (missing) {
    throw new Error(`The Pocock ${input.role} role requires completed ${missing} evidence`)
  }
}

export function resolvePocockImplementerSessionID(
  tasks: readonly PolicyTask[],
  blockedBy: readonly string[],
  executionMode?: ExecutionMode,
): string | undefined {
  if (executionMode?.kind === "native") {
    const keys = dependencyKeys(tasks, blockedBy)
    const task = tasks.find(task => task.key === executionMode.reuseFromTaskKey && keys.has(task.key))
    return task?.role === "implementer" && task.status === "completed" && !task.replacedByTaskKey
      && task.report?.outcome === "completed" && task.report.sessionId === task.actorSessionId
      && task.report.taskKey === task.key ? task.actorSessionId : undefined
  }
  const ancestors = dependencyKeys(tasks, blockedBy, true)

  const liveImplementers = tasks.filter(task => task.role === "implementer" && task.status === "completed" && task.actorSessionId)
  const dependencyImplementers = liveImplementers.filter(task => ancestors.has(task.key))
  const candidates = dependencyImplementers.length > 0 ? dependencyImplementers : liveImplementers
  const candidateSessionIDs = [...new Set(candidates.flatMap(task => task.actorSessionId ? [task.actorSessionId] : []))]
  return candidateSessionIDs.length === 1 ? candidateSessionIDs[0] : undefined
}

export function validateMissionCompletionPolicy(input: {
  template: MissionTemplateId
  outcome: "completed" | "failed"
  tasks: readonly (Pick<MissionTask, "role" | "status"> & Partial<MissionTask>)[]
}): void {
  if (input.template !== "pocock-fix-bug" || input.outcome !== "completed") return
  if (input.tasks.some(task => task.executionMode)) {
    const tasks = input.tasks.filter((task): task is MissionTask => Boolean(task.key && task.blockedBy))
    const liveFixes = tasks.filter(task => task.role === "implementer" && task.status !== "withdrawn" && !task.replacedByTaskKey)
    // contractGeneration is per-task, not a global chronology. Dependency tips also disambiguate
    // implementation steps declared together in one revision with the same creation timestamp.
    const tips = liveFixes.filter(task => !liveFixes.some(other => other.key !== task.key
      && dependencyKeys(tasks, other.blockedBy).has(task.key)))
    const newestTime = Math.max(...tips.map(task => task.createdAt))
    const newest = tips.filter(task => task.createdAt === newestTime)
    const latest = newest.length === 1 ? newest[0] : undefined
    if (!latest || latest.status !== "completed") throw new Error("A green Pocock mission requires the latest live implementation")
    const completed = (role: string) => tasks.filter(task => task.role === role && task.status === "completed" && !task.replacedByTaskKey)
    const connected = (task: MissionTask, key: string) => dependencyKeys(tasks, task.blockedBy).has(key)
    let chain: MissionTask[] | undefined
    for (const validator of completed("validator")) {
      for (const resolver of completed("resolver").filter(task => connected(validator, task.key))) {
        const standards = completed("review-standards").find(task => connected(resolver, task.key) && connected(task, latest.key))
        const spec = completed("review-spec").find(task => connected(resolver, task.key) && connected(task, latest.key))
        if (standards && spec) { chain = [validator, resolver, standards, spec]; break }
      }
      if (chain) break
    }
    const diagnosis = completed("diagnostician").find(task => connected(latest, task.key))
    if (!chain || !diagnosis) throw new Error("A green Pocock mission requires dependency-connected evidence for the latest live implementation")
    for (const task of [latest, diagnosis, ...chain]) {
      // Coordinator readout is business evidence validated by the journal, not
      // an assertion of native child/profile identity. Qualified reports still
      // require their exact assigned actor.
      const readout = task.executionMode?.kind === "native" && task.report?.delivery === "coordinator-readout"
      if (!task.report || task.report.outcome !== "completed" || task.report.taskKey !== task.key
        || (!readout && task.report.sessionId !== task.actorSessionId)) {
        throw new Error(`A green Pocock mission requires an exact completed ${task.role} report`)
      }
      validateMissionReportArtifact({ template: input.template, role: task.role, outcome: "completed", artifact: task.report.artifact })
    }
    return
  }
  const missing = Object.keys(pocockContracts)
    .find((role) => !input.tasks.some((task) => task.role === role && task.status === "completed"))
  if (missing) throw new Error(`A green Pocock mission requires completed ${missing} evidence`)
}

export function validateMissionReportArtifact(input: {
  template: MissionTemplateId
  role: string
  outcome: MissionReportOutcome
  artifact?: MissionJsonValue
  /** Explicit native admission only; historical/root reports remain unchanged. */
  nativeDecision?: NativeDecisionArtifactBinding
}): MissionJsonValue | undefined {
  if (input.template === "wayfinder" && input.role === "decision" && input.outcome === "completed" && input.nativeDecision) {
    validateNativeDecisionArtifact({ ...input.nativeDecision, artifact: input.artifact })
    return input.artifact
  }
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
