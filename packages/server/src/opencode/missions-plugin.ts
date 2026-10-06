import {
  MissionControl,
  MissionControlError,
} from "../missions/control"
import type {
  MissionDelegateInput,
  MissionCreateInput,
  MissionUpdateInput,
  MissionDeleteInput,
  MissionReviseInput,
  MissionInspectInput,
  MissionReportInput,
  MissionSessionAdapter,
  MissionInputTransport,
  MissionManagedRootCreation,
  MissionNativeReportAuthorization,
} from "../missions/control-types"
import { MISSION_SCHEMA_VERSION, type MissionEvent, type MissionJsonValue, type MissionTemplateId } from "../missions/model"
import { parseMissionEvent } from "../missions/journal"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { executionSchema, parseExecution } from "../missions/execution"
import { readMissionCatalog, validateNativeExecution, type MissionCatalogClient } from "../missions/native-catalog"
import { MissionNotificationOutbox } from "../missions/notification-outbox"
import { MISSION_RPC_REJECTION, missionMutationStatus } from "../missions/rpc-errors"
import { readLocationRef } from "./compatibility/location"
import { taskExecutionModeSchema, taskContractReferenceWireSchema } from "../missions/native-wire-schema"
import { parseExecutionMode } from "../missions/task-execution-mode"
import { normalizeTaskDeclaration, taskContractReferenceSchema } from "../missions/task-declaration"
import { parseMissionProfiles, missionProfilesSchema, validateMissionProfileCatalog } from "../missions/playbook-profiles"
import { buildAssignmentPrompt } from "../missions/recipes"
import { missionBriefingSchema, parseMissionBriefingInput } from "../missions/briefing"
import { MissionCreateNoEffectError } from "../missions/control-error"

interface MutationContext {
  error(type: typeof MISSION_RPC_REJECTION, message: string, data: { code: string; noEffect?: { requestID: string; missionID: string } }): unknown
}

async function mutationResult(context: MutationContext, action: () => Promise<unknown>): Promise<unknown> {
  try {
    return JSON.parse(JSON.stringify(await action()))
  } catch (error) {
    if (error instanceof MissionControlError && missionMutationStatus(error.code)) {
      return context.error(MISSION_RPC_REJECTION, error.message, { code: error.code,
        ...(error instanceof MissionCreateNoEffectError ? { noEffect: error.noEffect } : {}) })
    }
    throw error
  }
}

interface Registration {
  dispose(): Promise<void>
}

interface ToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  progress(update: Record<string, unknown>): Promise<void>
}

interface ToolDraft {
  namespace(namespace: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options: { namespace: string; codemode: false }
    execute(input: unknown, context: ToolContext): Promise<{ content: string }>
  }): void
}

export interface MissionsPluginContext extends MissionCatalogClient {
  location: {
    directory: string
    workspaceID?: string
    project: { id: string; canonical: string }
  }
  storage: {
    get(key: string): Promise<MissionJsonValue | undefined>
    set(key: string, value: MissionJsonValue): Promise<void>
    remove(key: string): Promise<void>
    scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: readonly { key: string; value: MissionJsonValue }[]
      next?: string
    }>
  }
  session: MissionSessionAdapter & {
    hook(name: "context", callback: (event: {
      sessionID: string
      system: Array<{ type: "text"; text: string }>
      tools: Record<string, unknown>
    }) => Promise<void> | void): Promise<Registration>
  }
  tool: {
    transform(callback: (draft: ToolDraft) => void): Promise<Registration>
  }
    rpc: {
      register(
        definition: typeof CODENOMAD_MISSIONS_RPC,
      handlers: {
        snapshot(input: unknown): Promise<unknown>
        lifecycle(input: unknown, context: MutationContext): Promise<unknown>
        recover(input: unknown, context: MutationContext): Promise<unknown>
        cleanupTarget(input: unknown): Promise<unknown>
        create(input: unknown, context: MutationContext): Promise<unknown>
        update(input: unknown, context: MutationContext): Promise<unknown>
        delete(input: unknown, context: MutationContext): Promise<unknown>
      },
    ): Promise<Registration & { events: { emit(name: "changed", data: { missionID: string; revision: number }): Promise<void> } }>
  }
}

// Opt-in native continuity seam. The desktop setup keeps its existing defaults.
export interface MissionsPluginPolicy {
  configure(control: MissionControl): Promise<void>
  beforeTool(name: "inspect" | "declare" | "delegate" | "revise" | "report" | "briefing", input: unknown, sessionID: string): Promise<void>
  beforeJournalWrite(event: MissionEvent): Promise<void | (() => void)>
  authorizeNativeReport?: MissionNativeReportAuthorization
}

export async function setupMissionsPlugin(context: MissionsPluginContext, transport?: MissionInputTransport,
  policy?: MissionsPluginPolicy, createManagedRoot?: MissionManagedRootCreation): Promise<() => Promise<void>> {
  let active = true
  let notificationOutbox: MissionNotificationOutbox | undefined
  const registrations: Registration[] = []
  const assertActive = () => { if (!active) throw new Error("CodeNomad Missions is no longer available") }
  const dispose = async () => {
    active = false
    notificationOutbox?.dispose()
    notificationOutbox = undefined
    await Promise.allSettled(registrations.map(registration => registration.dispose()))
  }
  let rpcRegistration: Awaited<ReturnType<MissionsPluginContext["rpc"]["register"]>> | undefined
  const control = new MissionControl({
    project: {
      id: context.location.project.id,
      canonical: context.location.project.canonical,
      location: { directory: context.location.directory, workspaceID: context.location.workspaceID },
    },
    storage: policy ? { get: key => context.storage.get(key), scan: options => context.storage.scan(options), set: async (key, value, current) => {
      const event = parseMissionEvent(value)
      const publicationFence = event ? await policy.beforeJournalWrite(event) : undefined
      assertActive()
      publicationFence?.()
      current?.()
      await context.storage.set(key, value)
    } } : context.storage,
    sessions: context.session,
    isActive: () => active,
    transport,
    createManagedRoot,
    authorizeNativeReport: policy?.authorizeNativeReport,
    validateProfiles: async (profiles, directory) => {
      if (profiles) validateMissionProfileCatalog(profiles, await readMissionCatalog(context, directory))
    },
    validateExecution: async (input, coordinatorID) => {
      const session = await context.session.get({ sessionID: input.targetSessionID ?? coordinatorID })
      await validateNativeExecution(context, session.location.directory, input)
    },
    changed: (missionID, revision) => rpcRegistration?.events.emit("changed", { missionID, revision }) ?? Promise.resolve(),
  })

  try {
    await policy?.configure(control)
    rpcRegistration = await context.rpc.register(CODENOMAD_MISSIONS_RPC, {
      snapshot: async () => JSON.parse(JSON.stringify(await control.snapshot())),
      recover: async (input, context) => {
        assertActive()
        const value = object(input)
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
          || !["coordinator", "report"].includes(String(value.target))) throw new Error("Invalid recovery request")
        return mutationResult(context, () => control.recover({
          missionID: requiredText(value.missionID, "missionID", 100), expectedRevision: Number(value.expectedRevision),
          target: value.target as "coordinator" | "report", ...(value.taskKey === undefined ? {} : { taskKey: requiredText(value.taskKey, "taskKey", 100) }),
        }))
      },
      lifecycle: async (input, context) => {
        assertActive()
        const value = object(input)
        if (!["start", "pause", "stop"].includes(String(value.action)) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new Error("Invalid mission control")
        return mutationResult(context, () => control.lifecycle({
          missionID: requiredText(value.missionID, "missionID", 100), requestID: requiredText(value.requestID, "requestID", 128),
          action: value.action as "start" | "pause" | "stop", expectedRevision: Number(value.expectedRevision),
        }))
      },
      cleanupTarget: async input => {
        assertActive()
        const value = object(input)
        return JSON.parse(JSON.stringify(await control.cleanupTarget({
          missionID: requiredText(value.missionID, "missionID", 100), deletionID: requiredText(value.deletionID, "deletionID", 100),
          sessionID: requiredText(value.sessionID, "sessionID", 240),
        })))
      },
      create: async (input, context) => { assertActive(); return mutationResult(context, () => control.create(parseCreateMissionInput(input))) },
      update: async (input, context) => { assertActive(); return mutationResult(context, () => control.update(parseUpdateMissionInput(input))) },
      delete: async (input, context) => { assertActive(); return mutationResult(context, () => control.delete(parseDeleteMissionInput(input))) },
    })
    registrations.push(rpcRegistration)

    const tools = await context.tool.transform((draft) => {
      draft.namespace({
        name: "mission",
        description: "Declare bounded native tasks and explicit independent-session exceptions through one durable business mission map.",
      })
      draft.add({
        name: "inspect",
        description: "Inspect the caller's durable mission map and optional native catalog, or start a custom, Pocock bug-fix, or Wayfinder mission.",
        input: inspectSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          await policy?.beforeTool("inspect", input, tool.sessionID)
          assertActive()
          await tool.progress({ status: "Reading the mission map" })
          const result = await control.inspect(tool.sessionID, parseInspectInput(input), tool.id)
          if (object(input).catalog === true) {
            const session = await context.session.get({ sessionID: tool.sessionID })
            result.catalog = await readMissionCatalog(context, session.location.directory)
          }
          return textResult(result)
        },
      })
      draft.add({
        name: "delegate",
        description: "Declare one dependency-aware native task without creating or prompting a session. Pass the returned canonical assignmentPrompt to ordinary native subagent calls for ready tasks; run independent ready work in parallel when useful and let children own bounded recursive decomposition within native permissions and configured depth. The coordinator records business readout with mission.report and taskKey, without child report copies or invocation bindings. Explicit independent execution requires a reason and may dispatch a root exception. Coordinator only; inspect the native catalog before selecting agent/model IDs.",
        input: delegateSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const value = object(input)
          const mode = parseExecutionMode(value.executionMode)
          const independent = mode?.kind === "independent"
          if (!independent && (value.targetSessionID !== undefined || value.delivery !== undefined)) {
            throw new MissionControlError("Root target/delivery requires an explicit independent execution reason", "invalid-contract")
          }
          await policy?.beforeTool(independent ? "delegate" : "declare", input, tool.sessionID)
          assertActive()
          await tool.progress({ status: independent ? "Delegating independent mission task" : "Declaring native mission task" })
          if (independent) return textResult(await control.delegate(tool.sessionID, parseDelegateInput(input)))
          const result = await control.declare(tool.sessionID, normalizeTaskDeclaration({ ...value, blockedBy: value.blockedBy ?? [] }))
          const task = result.mission.tasks.find(candidate => candidate.key === result.contract.taskKey)
          if (!task || task.executionMode?.kind !== "native" || task.contractGeneration !== result.contract.generation) {
            throw new MissionControlError("Declared native task context unavailable", "invalid-journal")
          }
          return textResult({ ...result, assignmentPrompt: buildAssignmentPrompt(result.mission, task) })
        },
      })
      draft.add({
        name: "revise",
        description: "Revise the current mission plan with a reason and expected revision. Coordinator only. Add newly discovered work, retire/replace tasks or rewrite dependencies atomically; this does not cancel already admitted native execution.",
        input: reviseSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          await policy?.beforeTool("revise", input, tool.sessionID)
          assertActive()
          await tool.progress({ status: "Revising mission plan" })
          return textResult(await control.revise(tool.sessionID, parseReviseInput(input)))
        },
      })
      draft.add({
        name: "report",
        description: "Coordinator: settle a declared native task with taskKey and actual returned evidence from ordinary native work, including any child-owned recursive helpers; do not ask descendants for duplicate mission reports. Finalize when the plan is complete. This business readout does not prove native execution ended or human consent. Independent-root actors report their assigned tasks as before. Qualified native actors may optionally supply an exact contract through the stronger native-return route. Only the coordinator may finalize.",
        input: reportSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          await policy?.beforeTool("report", input, tool.sessionID)
          assertActive()
          await tool.progress({ status: "Recording mission report" })
          const report = parseReportInput(input)
          const reference = object(input).contract
          return textResult(reference === undefined ? await control.report(tool.sessionID, report)
            : await control.reportNative({ contract: taskContractReferenceSchema.parse(reference),
              sessionID: tool.sessionID, toolCallID: tool.id, messageID: tool.messageID }, report))
        },
      })
      draft.add({
        name: "briefing",
        description: "Coordinator only: publish a short user-facing project briefing, separate from task results and observed activity. Inspect the current mission first and pass its revision as basedOnRevision. Explain usable achievements, remaining work, obstacles and the next step in the user's language; reference exact live task keys where relevant. A briefing does not settle tasks, grant human consent, change the plan or finish the mission. Use the requestID from an explicit UI request; otherwise a unique initial briefing ID. On a revision conflict reread before publishing, never replay work.",
        input: missionBriefingSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          await policy?.beforeTool("briefing", input, tool.sessionID)
          assertActive()
          await tool.progress({ status: "Recording project briefing" })
          return textResult(await control.briefing(tool.sessionID, parseMissionBriefingInput(input)))
        },
      })
    })
    registrations.push(tools)

    const contextHook = await context.session.hook("context", async (event) => {
      if (!active) return
      try {
        const instruction = await control.contextFor(event.sessionID)
        if (!instruction) return
        event.system.push({ type: "text", text: instruction })
        const snapshot = await control.snapshot()
        const mission = snapshot.missions.find((candidate) => candidate.status === "active"
          && candidate.actors.some((actor) => actor.sessionId === event.sessionID))
        if (mission && mission.coordinatorSessionId !== event.sessionID) {
          delete event.tools.mission_delegate
          delete event.tools.mission_revise
          delete event.tools.mission_briefing
        }
      } catch {
        // Mission context is additive. A damaged optional map must not block an otherwise valid model request.
      }
    })
    registrations.push(contextHook)
    notificationOutbox = new MissionNotificationOutbox(
      `${context.location.project.id}\0${context.location.project.canonical}`,
      (isActive, after) => control.retryPendingNotifications(isActive, after),
    )
    notificationOutbox.start()
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}

const inspectSchema = {
  type: "object",
  properties: {
    missionID: { type: "string", description: "Mission to inspect; omit to use the caller's active mission." },
    catalog: { type: "boolean", description: "Include the native agent, enabled model and variant catalog for this session's location." },
    start: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 20_000 },
        template: { type: "string", enum: ["custom", "pocock-fix-bug", "wayfinder"] },
        notes: { type: "string", maxLength: 20_000 },
        profiles: missionProfilesSchema,
      },
      required: ["objective", "template"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const delegateSchema = {
  type: "object",
  properties: {
    missionID: { type: "string" },
    taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
    title: { type: "string", minLength: 1, maxLength: 240 },
    brief: { type: "string", minLength: 1, maxLength: 20_000 },
    role: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
    execution: { ...executionSchema, description: "Native agent/model selection, independent of role. Native children use subagent/all profiles; independent roots use primary/all. Existing actors must match; never switch a busy session." },
    executionMode: { ...taskExecutionModeSchema, description: "Omit for a native task under the coordinator. Native parent/reuse task references are explicit; independent roots require a bounded reason and explanation." },
    blockedBy: { type: "array", maxItems: 24, items: { type: "string" } },
    targetSessionID: { type: "string", description: "Independent mode only: existing owned root to reuse. Native exact-child continuation belongs to the native subagent call, not this declaration." },
    delivery: { type: "string", enum: ["queue", "steer"], description: "Independent mode only: root assignment inbox delivery." },
  },
  required: ["taskKey", "title", "brief", "role"],
  additionalProperties: false,
}

const reportSchema = {
  type: "object",
  properties: {
    contract: { ...taskContractReferenceWireSchema, description: "Optional qualified native-actor route only: exact declared task generation. Omit for coordinator business readout or independent-root reporting; ordinary native children need not call mission.report." },
    missionID: { type: "string" },
    taskKey: { type: "string" },
    outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 20_000 },
    evidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 2_000 } },
    next: { type: "array", maxItems: 12, items: { type: "string", maxLength: 2_000 } },
    artifact: { description: "Optional structured playbook evidence. Required for completed Pocock tasks." },
    final: { type: "boolean", description: "Coordinator-only terminal mission report." },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
}

export function parseInspectInput(input: unknown): MissionInspectInput {
  const value = object(input)
  const missionID = optionalText(value.missionID, "missionID", 100)
  if (value.start === undefined) return { missionID }
  const start = object(value.start)
  const template = requiredText(start.template, "start.template", 40)
  if (!isTemplate(template)) throw new Error("start.template is unsupported")
  return {
    missionID,
    start: {
      objective: requiredText(start.objective, "start.objective", 20_000),
      template,
      notes: optionalText(start.notes, "start.notes", 20_000),
      ...(start.profiles === undefined ? {} : { profiles: parseMissionProfiles(start.profiles) }),
    },
  }
}

const reviseSchema = {
  type: "object",
  properties: {
    missionID: { type: "string", maxLength: 100 },
    expectedRevision: { type: "integer", minimum: 1 },
    requestID: { type: "string", minLength: 1, maxLength: 128 },
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    objective: { type: "string", minLength: 1, maxLength: 20_000 },
    notes: { type: "string", maxLength: 20_000 },
    retireTasks: {
      type: "array", maxItems: 24, items: {
        type: "object", properties: {
          taskKey: { type: "string", minLength: 2, maxLength: 64 },
          replacementTaskKey: { type: "string", minLength: 2, maxLength: 64 },
        }, required: ["taskKey"], additionalProperties: false,
      },
    },
    addTasks: {
      type: "array", maxItems: 24, items: {
        type: "object", properties: {
          taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
          title: { type: "string", minLength: 1, maxLength: 240 },
          brief: { type: "string", minLength: 1, maxLength: 20_000 },
          role: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
          execution: executionSchema,
          executionMode: taskExecutionModeSchema,
          blockedBy: { type: "array", maxItems: 24, items: { type: "string", maxLength: 64 } },
          replacesTaskKey: { type: "string", minLength: 2, maxLength: 64 },
        }, required: ["taskKey", "title", "brief", "role", "blockedBy"], additionalProperties: false,
      },
    },
    dependencyUpdates: {
      type: "array", maxItems: 96, items: {
        type: "object", properties: {
          taskKey: { type: "string", minLength: 2, maxLength: 64 },
          blockedBy: { type: "array", maxItems: 24, items: { type: "string", maxLength: 64 } },
        }, required: ["taskKey", "blockedBy"], additionalProperties: false,
      },
    },
  },
  required: ["expectedRevision", "requestID", "reason"],
  additionalProperties: false,
}

function parseCreateMissionInput(input: unknown): MissionCreateInput {
  const value = object(input)
  const template = requiredText(value.template, "template", 40)
  if (!isTemplate(template)) throw new Error("template is unsupported")
  if (value.prepared !== undefined && typeof value.prepared !== "boolean") throw new Error("prepared must be boolean")
  return {
    ...(value.prepared === undefined ? {} : { prepared: value.prepared as boolean }),
    requestID: requiredText(value.requestID, "requestID", 128),
    objective: requiredText(value.objective, "objective", 20_000),
    notes: optionalBodyText(value.notes, "notes", 20_000),
    template,
    ...(value.profiles === undefined ? {} : { profiles: parseMissionProfiles(value.profiles) }),
    coordinatorSessionID: optionalText(value.coordinatorSessionID, "coordinatorSessionID", 240),
    ...(value.expectedCoordinatorLocation === undefined ? {} : { expectedCoordinatorLocation: readLocationRef(value.expectedCoordinatorLocation) }),
  }
}

function parseUpdateMissionInput(input: unknown): MissionUpdateInput {
  const value = object(input)
  const expectedRevision = value.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new Error("expectedRevision must be a positive integer")
  return {
    missionID: requiredText(value.missionID, "missionID", 100),
    requestID: requiredText(value.requestID, "requestID", 128),
    objective: requiredText(value.objective, "objective", 20_000),
    notes: optionalBodyText(value.notes, "notes", 20_000),
    expectedRevision: Number(expectedRevision),
  }
}

function parseDeleteMissionInput(input: unknown): MissionDeleteInput {
  const value = object(input)
  if (value.deleteManagedSessions !== undefined && typeof value.deleteManagedSessions !== "boolean") throw new MissionControlError("deleteManagedSessions must be a boolean", "invalid-delete-option")
  const expectedRevision = value.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new Error("expectedRevision must be a positive integer")
  return {
    missionID: requiredText(value.missionID, "missionID", 100),
    requestID: requiredText(value.requestID, "requestID", 128),
    expectedRevision: Number(expectedRevision),
    deleteManagedSessions: value.deleteManagedSessions as boolean | undefined,
  }
}

export function parseDelegateInput(input: unknown): MissionDelegateInput {
  const value = object(input)
  const taskKey = identifier(value.taskKey, "taskKey")
  const blockedBy = stringList(value.blockedBy, "blockedBy", 24, 64)
  return {
    missionID: optionalText(value.missionID, "missionID", 100),
    taskKey,
    title: requiredText(value.title, "title", 240),
    brief: requiredText(value.brief, "brief", 20_000),
    role: identifier(value.role, "role"),
    ...(value.execution === undefined ? {} : { execution: parseExecution(value.execution) }),
    ...(value.executionMode === undefined ? {} : { executionMode: parseExecutionMode(value.executionMode) }),
    blockedBy,
    targetSessionID: optionalText(value.targetSessionID, "targetSessionID", 240),
    delivery: value.delivery === undefined ? "queue" : delivery(value.delivery),
  }
}

export function parseReportInput(input: unknown): MissionReportInput {
  const value = object(input)
  const outcome = requiredText(value.outcome, "outcome", 20)
  if (outcome !== "completed" && outcome !== "blocked" && outcome !== "failed") throw new Error("outcome is unsupported")
  return {
    missionID: optionalText(value.missionID, "missionID", 100),
    taskKey: optionalText(value.taskKey, "taskKey", 64),
    outcome,
    summary: requiredText(value.summary, "summary", 20_000),
    evidence: stringList(value.evidence, "evidence", 12, 2_000),
    next: stringList(value.next, "next", 12, 2_000),
    artifact: optionalJson(value.artifact),
    final: value.final === true,
  }
}

function textResult(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mission input must be an object")
  return value as Record<string, unknown>
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, max)
}

export function parseReviseInput(input: unknown): MissionReviseInput {
  const value = object(input)
  const expectedRevision = value.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new Error("expectedRevision must be a positive integer")
  const requestID = requiredText(value.requestID, "requestID", 128)
  const reason = requiredText(value.reason, "reason", 2_000)
  const retireTasks = value.retireTasks === undefined ? [] : value.retireTasks
  if (!Array.isArray(retireTasks) || retireTasks.length > 24) throw new Error("retireTasks must contain at most 24 entries")
  const addTasks = value.addTasks === undefined ? [] : value.addTasks
  if (!Array.isArray(addTasks) || addTasks.length > 24) throw new Error("addTasks must contain at most 24 entries")
  const dependencyUpdates = value.dependencyUpdates === undefined ? [] : value.dependencyUpdates
  if (!Array.isArray(dependencyUpdates) || dependencyUpdates.length > 96) throw new Error("dependencyUpdates must contain at most 96 entries")
  const parseKey = (item: unknown, name: string) => identifier(item, name)
  const parsedRetire = retireTasks.map((item, index) => {
    const entry = object(item)
    return {
      taskKey: parseKey(entry.taskKey, `retireTasks[${index}].taskKey`),
      ...(entry.replacementTaskKey === undefined ? {} : { replacementTaskKey: parseKey(entry.replacementTaskKey, `retireTasks[${index}].replacementTaskKey`) }),
    }
  })
  const parsedAdd = addTasks.map((item, index) => {
    const entry = object(item)
    return {
      taskKey: identifier(entry.taskKey, `addTasks[${index}].taskKey`),
      title: requiredText(entry.title, `addTasks[${index}].title`, 240),
      brief: requiredText(entry.brief, `addTasks[${index}].brief`, 20_000),
      role: identifier(entry.role, `addTasks[${index}].role`),
      ...(entry.execution === undefined ? {} : { execution: parseExecution(entry.execution) }),
      ...(entry.executionMode === undefined ? {} : { executionMode: parseExecutionMode(entry.executionMode) }),
      blockedBy: stringList(entry.blockedBy, `addTasks[${index}].blockedBy`, 24, 64),
      ...(entry.replacesTaskKey === undefined ? {} : { replacesTaskKey: identifier(entry.replacesTaskKey, `addTasks[${index}].replacesTaskKey`) }),
    }
  })
  const parsedDependencies = dependencyUpdates.map((item, index) => {
    const entry = object(item)
    return {
      taskKey: identifier(entry.taskKey, `dependencyUpdates[${index}].taskKey`),
      blockedBy: stringList(entry.blockedBy, `dependencyUpdates[${index}].blockedBy`, 24, 64),
    }
  })
  const objective = value.objective === undefined ? undefined : requiredText(value.objective, "objective", 20_000)
  const notes = optionalBodyText(value.notes, "notes", 20_000)
  return {
    missionID: optionalText(value.missionID, "missionID", 100),
    expectedRevision: Number(expectedRevision), requestID, reason, objective, notes,
    retireTasks: parsedRetire, addTasks: parsedAdd, dependencyUpdates: parsedDependencies,
  }
}

function optionalBodyText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be a string of at most ${max} characters`)
  return value
}

function identifier(value: unknown, name: string): string {
  const result = requiredText(value, name, 64)
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(result)) throw new Error(`${name} must be a lowercase mission identifier`)
  return result
}

function stringList(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} strings`)
  return value.map((item, index) => requiredText(item, `${name}[${index}]`, maxLength))
}

function delivery(value: unknown): "queue" | "steer" {
  if (value !== "queue" && value !== "steer") throw new Error("delivery must be queue or steer")
  return value
}

function isTemplate(value: string): value is MissionTemplateId {
  return value === "custom" || value === "pocock-fix-bug" || value === "wayfinder"
}

function optionalJson(value: unknown): MissionJsonValue | undefined {
  if (value === undefined) return undefined
  const encoded = JSON.stringify(value)
  if (encoded === undefined || encoded.length > 50_000) throw new Error("artifact must be JSON smaller than 50000 characters")
  return JSON.parse(encoded) as MissionJsonValue
}

export default {
  id: "codenomad.missions",
  setup: setupMissionsPlugin,
}
