import { z } from "zod"
import type { MissionDeclareInput } from "./control-types"
import { MissionControlError } from "./control-error"
import { parseExecution } from "./execution"
import type { MissionTask } from "./model"
import { parseExecutionMode } from "./task-execution-mode"

const taskKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/)

/** This reference is a task generation, never a journal/document revision. */
export const taskContractReferenceSchema = z.object({
  missionID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
  taskKey,
  generation: z.number().int().positive().safe(),
}).strict()
export type TaskContractReference = z.infer<typeof taskContractReferenceSchema>

const declarationSchema = z.object({
  missionID: taskContractReferenceSchema.shape.missionID.optional(),
  taskKey,
  title: z.string().trim().min(1).max(240),
  brief: z.string().min(1).max(20_000).refine(value => Boolean(value.trim())),
  role: taskKey,
  blockedBy: z.array(taskKey).max(24),
  execution: z.unknown().transform(parseExecution).optional(),
  executionMode: z.unknown().optional(),
}).strict()

export function normalizeTaskDeclaration(raw: unknown): MissionDeclareInput {
  const input = declarationSchema.parse(raw)
  const executionMode = input.executionMode === undefined
    ? { kind: "native" as const, parentTaskKey: null }
    : parseExecutionMode(input.executionMode)
  if (!executionMode) throw new MissionControlError("Invalid task execution mode", "invalid-contract")
  return { ...input, executionMode, blockedBy: [...new Set(input.blockedBy)].sort() }
}

type PlannedTask = Pick<MissionTask, "key" | "blockedBy" | "executionMode" | "status">

/** Validates business edges without deriving native ancestry or executing work. */
export function validateTaskAdmissionGraph(tasks: readonly PlannedTask[]): void {
  const live = tasks.filter(task => task.status !== "withdrawn")
  const byKey = new Map(live.map(task => [task.key, task]))
  if (byKey.size !== live.length) throw new MissionControlError("Task keys must be unique", "task-conflict")
  for (const task of live) {
    for (const key of task.blockedBy) {
      if (key === task.key || !byKey.has(key)) throw new MissionControlError("Dependency is unknown, retired or self-referential", "invalid-blocker")
    }
    const mode = task.executionMode
    if (mode?.kind === "native" && mode.reuseFromTaskKey === task.key) {
      throw new MissionControlError("Task cannot reuse itself as its prior actor source", "invalid-reuse")
    }
    if (mode?.kind === "native" && mode.parentTaskKey !== null) {
      if (mode.parentTaskKey === task.key || !byKey.has(mode.parentTaskKey)) {
        throw new MissionControlError("Native parent task is unknown, retired or self-referential", "invalid-parent")
      }
    }
  }
  const visiting = new Set<string>(), checked = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new MissionControlError("Task parent/dependency admission graph cannot contain a cycle", "dependency-cycle")
    if (checked.has(key)) return
    visiting.add(key)
    const task = byKey.get(key)!
    const mode = task.executionMode
    for (const edge of [...task.blockedBy, ...(mode?.kind === "native" && mode.parentTaskKey !== null ? [mode.parentTaskKey] : []),
      ...(mode?.kind === "native" && mode.reuseFromTaskKey && byKey.has(mode.reuseFromTaskKey) ? [mode.reuseFromTaskKey] : [])]) visit(edge)
    visiting.delete(key)
    checked.add(key)
  }
  for (const key of byKey.keys()) visit(key)
}

/** Actor reuse is an explicit identity choice, not a permission to pick another. */
export function validateTaskActorChoice(mission: { tasks: readonly Pick<MissionTask, "key" | "executionMode">[] }, input: MissionDeclareInput): void {
  const mode = input.executionMode
  if (mode?.kind !== "native" || mode.reuseFromTaskKey === undefined) return
  const source = mission.tasks.find(task => task.key === mode.reuseFromTaskKey)
  if (source?.executionMode?.kind !== "native") {
    throw new MissionControlError("Reuse source is not a declared native task", "invalid-reuse")
  }
  if (source.executionMode.parentTaskKey !== mode.parentTaskKey) {
    throw new MissionControlError("Native actor reuse requires the exact unchanged parent", "invalid-reuse")
  }
  // Binding, completion, current-call termination, fresh idle and actual parent
  // identity are admission gates. A frontier can declare explicit future reuse
  // before its source has created an actor; declaration cannot execute that reuse.
}
