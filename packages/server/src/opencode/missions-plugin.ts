import {
  MissionControl,
  MissionControlError,
  NO_TASK_CONVERSATION,
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
  MissionPrepareRequest,
} from "../missions/control-types"
import { MISSION_SCHEMA_VERSION, type MissionEvent, type MissionJsonValue, type MissionMap, type MissionTemplateId } from "../missions/model"
import { parseMissionEvent } from "../missions/journal"
import { missionPausedInstruction } from "../missions/lifecycle-model"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { executionSchema, parseExecution } from "../missions/execution"
import { readMissionCatalog, validateNativeExecution, type MissionCatalogClient } from "../missions/native-catalog"
import { MissionNotificationOutbox } from "../missions/notification-outbox"
import { MISSION_RPC_REJECTION, missionMutationStatus } from "../missions/rpc-errors"
import { readLocationRef, sameLocation } from "./compatibility/location"
import { taskExecutionModeSchema, taskContractReferenceWireSchema } from "../missions/native-wire-schema"
import { parseExecutionMode, parseMissionTaskMode, missionTaskModeSchema } from "../missions/task-execution-mode"
import { normalizeTaskDeclaration, taskContractReferenceSchema } from "../missions/task-declaration"
import { parseMissionProfiles, missionProfilesSchema, validateMissionProfileCatalog } from "../missions/playbook-profiles"
import { boundedInterruption, boundedMutation, boundedRevision, compactMission, compactMissionTask, compactMissionTasks, nativeAssignment } from "../missions/tool-result"
import { missionContentRequestSchema } from "../missions/mission-content"
import { missionTaskRequestSchema } from "../missions/mission-compact-map"
import { missionPanelPageRequestSchema } from "../missions/mission-panel-page"
import { MISSION_TASK_VIEW_FIELDS, boundedInspection, boundedMissionList, boundedTaskView, inspectionContent,
  inspectionContentValue, type MissionInspectContent } from "../missions/inspect-view"
import { InterruptReceipts } from "../missions/interrupt-receipts"
import { missionBriefingToolSchema, parseMissionBriefingRequest } from "../missions/briefing"
import { MissionCreateNoEffectError } from "../missions/control-error"
import { MISSION_TITLE_MAX, parseMissionTitle } from "../missions/mission-title"
import { MISSION_LIST_MAX_INCLUDE } from "../missions/mission-summary"
import { createMissionWriterRetirement } from "./missions/writer-retirement"
import type { NativeHumanAnswerGate } from "../missions/human-answer"
import type { MissionJournalIndex } from "../missions/journal-index"
import type { MissionDocumentAccess } from "../missions/mission-document-one-time"
import { NativeMissionDocumentStore } from "../missions/mission-document-store"
import type { MissionBusinessControl, MissionBusinessMutationMap } from "../missions/business-control"

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
        scheduleRead(input: unknown): Promise<unknown>
        scheduleControl(input: unknown): Promise<unknown>
        scheduleCarrierRead(input: unknown): Promise<unknown>
        documentCapabilities(input: unknown): Promise<unknown>
        documentActivation(input: unknown): Promise<unknown>
        snapshot(input: unknown): Promise<unknown>
        list(input: unknown): Promise<unknown>
        mission(input: unknown): Promise<unknown>
        content(input: unknown): Promise<unknown>
        tasks(input: unknown): Promise<unknown>
        panelPage(input: unknown): Promise<unknown>
        recurrenceSnapshot(input: unknown): Promise<unknown>
        recurrenceControl(input: unknown): Promise<unknown>
        recurrenceControlStatus(input: unknown): Promise<unknown>
        recurrenceRunNow(input: unknown): Promise<unknown>
        recurrenceRunNowStatus(input: unknown): Promise<unknown>
        recurrenceRead(input: unknown): Promise<unknown>
        recurrenceCreate(input: unknown): Promise<unknown>
        recurrenceCurrent(input: unknown): Promise<unknown>
        recurrenceCurrentContent(input: unknown): Promise<unknown>
        recurrencePassageRead(input: unknown): Promise<unknown>
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
  beforeTool(name: "inspect" | "declare" | "delegate" | "revise" | "report" | "briefing" | "interrupt" | "prepare", input: unknown, sessionID: string): Promise<void>
  beforeJournalWrite(event: MissionEvent): Promise<void | (() => void)>
  authorizeNativeReport?: MissionNativeReportAuthorization
}

export async function setupMissionsPlugin(context: MissionsPluginContext, transport?: MissionInputTransport,
  policy?: MissionsPluginPolicy, createManagedRoot?: MissionManagedRootCreation, humanGate?: NativeHumanAnswerGate, business = true,
  journalIndex?: MissionJournalIndex, documents?: MissionDocumentAccess): Promise<() => Promise<void>> {
  let active = true
  let notificationOutbox: MissionNotificationOutbox | undefined
  const registrations: Registration[] = []
  // Drain this registration's journal and callback paths; the separate durable
  // authority RPC and native old-writer inventory still need their own proof.
  const writer = createMissionWriterRetirement()
  const tracked = <Args extends unknown[], Result>(callback: (...args: Args) => Promise<Result>) =>
    (...args: Args) => writer.run(() => callback(...args))
  const assertActive = () => { if (!active) throw new Error("CodeNomad Missions is no longer available") }
  const dispose = async () => {
    active = false
    notificationOutbox?.dispose()
    notificationOutbox = undefined
    await writer.retire(async () => {
      const results = await Promise.allSettled(registrations.map(registration => registration.dispose()))
      const failed = results.find(result => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })
  }
  let rpcRegistration: Awaited<ReturnType<MissionsPluginContext["rpc"]["register"]>> | undefined
  // Journal purges need native removal; a context without it keeps every entry.
  const removal = typeof context.storage.remove === "function" ? { remove: (key: string) => writer.run(async () => {
    assertActive()
    await writer.write(() => context.storage.remove(key))
  }) } : {}
  const control = new MissionControl({
    project: {
      id: context.location.project.id,
      canonical: context.location.project.canonical,
      location: { directory: context.location.directory, workspaceID: context.location.workspaceID },
    },
    storage: policy ? { get: key => context.storage.get(key), scan: options => context.storage.scan(options), set: (key, value, current) => writer.run(async () => {
      const event = parseMissionEvent(value)
      const publicationFence = event ? await policy.beforeJournalWrite(event) : undefined
      assertActive()
      publicationFence?.()
      current?.()
      await writer.write(() => context.storage.set(key, value))
    }), ...removal } : { get: key => context.storage.get(key), scan: options => context.storage.scan(options),
      set: (key, value, current) => writer.run(async () => {
        assertActive()
        current?.()
        await writer.write(() => context.storage.set(key, value))
      }), ...removal },
    sessions: context.session,
    isActive: () => active,
    transport,
    createManagedRoot,
    authorizeNativeReport: policy?.authorizeNativeReport,
    humanGate,
    journalIndex,
    documents,
    documentReads: documents ? async use => use(new NativeMissionDocumentStore({ get: key => context.storage.get(key),
      compareAndSet: async () => { throw new Error("Read-only Mission document projection") } }, context.location.project.id, context.location.project.canonical)) : undefined,
    completedFinalOnly: true,
    validateProfiles: async (profiles, directory, taskMode) => {
      if (profiles) validateMissionProfileCatalog(profiles, await readMissionCatalog(context, directory), taskMode)
    },
    validateExecution: async (input, coordinatorID) => {
      const session = await context.session.get({ sessionID: input.targetSessionID ?? coordinatorID })
      await validateNativeExecution(context, session.location.directory, input)
    },
    changed: (missionID, revision) => rpcRegistration?.events.emit("changed", { missionID, revision }) ?? Promise.resolve(),
  })

  try {
    await policy?.configure(control)
    const handlers: Parameters<MissionsPluginContext["rpc"]["register"]>[1] = {
      scheduleRead: async () => { throw new Error("Native Mission schedule graph unavailable") },
      scheduleControl: async () => { throw new Error("Native Mission schedule graph unavailable") },
      scheduleCarrierRead: async () => { throw new Error("Native Mission schedule graph unavailable") },
      documentCapabilities: async () => { throw new Error("Native Mission document graph unavailable") },
      documentActivation: async () => { throw new Error("Native Mission document graph unavailable") },
      snapshot: async () => JSON.parse(JSON.stringify(await control.snapshot())),
      list: async input => {
        const value = object(input)
        if (value.include !== undefined && (!Array.isArray(value.include) || value.include.length > MISSION_LIST_MAX_INCLUDE)) throw new Error("Invalid mission list request")
        return JSON.parse(JSON.stringify(await control.list({
          ...(value.include === undefined ? {} : { include: (value.include as unknown[]).map(id => requiredText(id, "missionID", 100)) }),
          ...(value.summariesVersion === undefined ? {} : { summariesVersion: requiredText(value.summariesVersion, "summariesVersion", 64) }),
        })))
      },
      mission: async input => JSON.parse(JSON.stringify(await control.mission(requiredText(object(input).missionID, "missionID", 100)))),
      content: async input => JSON.parse(JSON.stringify(await control.content(missionContentRequestSchema.parse(input)))),
      tasks: async input => JSON.parse(JSON.stringify(await control.tasks(missionTaskRequestSchema.parse(input)))),
      panelPage: async input => {
        const parsed = missionPanelPageRequestSchema.safeParse(input)
        return parsed.success ? JSON.parse(JSON.stringify(await control.panelPage(parsed.data))) : { available: false, reason: "invalid-request" }
      },
      // Bundled Effect entry replaces this at registration with the native
      // request-graph handlers. A Promise setup graph never has Job authority.
      recurrenceSnapshot: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrenceControl: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrenceControlStatus: async () => { throw new Error("Native recurrence status unavailable") },
      recurrenceRunNow: async () => { throw new Error("Native recurrence admission unavailable") },
      recurrenceRunNowStatus: async () => { throw new Error("Native recurrence status unavailable") },
      recurrenceRead: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrenceCreate: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrenceCurrent: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrenceCurrentContent: async () => { throw new Error("Native recurrence graph unavailable") },
      recurrencePassageRead: async () => { throw new Error("Native recurrence reader graph unavailable") },
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
        if (!["start", "pause", "stop"].includes(String(value.action)) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
          || (value.graceful !== undefined && (value.graceful !== true || value.action !== "pause"))) throw new Error("Invalid mission control")
        return mutationResult(context, () => control.lifecycle({
          missionID: requiredText(value.missionID, "missionID", 100), requestID: requiredText(value.requestID, "requestID", 128),
          action: value.action as "start" | "pause" | "stop", expectedRevision: Number(value.expectedRevision),
          ...(value.graceful === true ? { graceful: true as const } : {}),
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
    }
    rpcRegistration = await context.rpc.register(CODENOMAD_MISSIONS_RPC, {
      scheduleRead: tracked(handlers.scheduleRead), scheduleControl: tracked(handlers.scheduleControl),
      scheduleCarrierRead: tracked(handlers.scheduleCarrierRead),
      documentCapabilities: tracked(handlers.documentCapabilities),
      documentActivation: tracked(handlers.documentActivation),
      snapshot: tracked(handlers.snapshot), list: tracked(handlers.list), mission: tracked(handlers.mission),
      content: tracked(handlers.content), tasks: tracked(handlers.tasks), panelPage: tracked(handlers.panelPage), recurrenceSnapshot: tracked(handlers.recurrenceSnapshot),
      recurrenceControl: tracked(handlers.recurrenceControl), recurrenceControlStatus: tracked(handlers.recurrenceControlStatus),
      recurrenceRunNow: tracked(handlers.recurrenceRunNow), recurrenceRunNowStatus: tracked(handlers.recurrenceRunNowStatus),
      recurrenceRead: tracked(handlers.recurrenceRead),
      recurrenceCreate: tracked(handlers.recurrenceCreate),
      recurrenceCurrent: tracked(handlers.recurrenceCurrent), recurrenceCurrentContent: tracked(handlers.recurrenceCurrentContent),
      recurrencePassageRead: tracked(handlers.recurrencePassageRead),
      recover: tracked(handlers.recover), lifecycle: tracked(handlers.lifecycle),
      cleanupTarget: tracked(handlers.cleanupTarget), create: tracked(handlers.create),
      update: tracked(handlers.update), delete: tracked(handlers.delete),
    })
    registrations.push(rpcRegistration)

    if (business) registrations.push({ dispose: await setupMissionsBusiness(context, async sessionID => ({
      control, readSessionID: sessionID, current: assertActive,
      beforeTool: (name, input) => policy?.beforeTool(name, input, sessionID) ?? Promise.resolve(),
    })) })
    notificationOutbox = new MissionNotificationOutbox(
      `${context.location.project.id}\0${context.location.project.canonical}`,
      (isActive, after) => writer.run(() => control.retryPendingNotifications(isActive, after)),
    )
    notificationOutbox.start()
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}

export type { MissionBusinessControl } from "../missions/business-control"

export interface MissionBusinessRoute {
  control: MissionBusinessControl
  /** Schedule passages lock the document before entering MissionControl's writer. */
  execute?<T>(use: (control: MissionBusinessControl) => Promise<T>): Promise<T>
  /** Descendant reads use their verified root; mutations always retain the real caller. */
  readSessionID: string
  current(): void
  beforeTool(name: Parameters<MissionsPluginPolicy["beforeTool"]>[0], input: unknown): Promise<void>
}

const executeMissionBusiness = <T>(selected: MissionBusinessRoute, use: (control: MissionBusinessControl) => Promise<T>): Promise<T> =>
  selected.execute ? selected.execute(use) : use(selected.control)

/** One set of native names. Selection is invocation-scoped, never model-provided storage. */
export async function setupMissionsBusiness(context: MissionsPluginContext,
  select: (sessionID: string) => Promise<MissionBusinessRoute | undefined>): Promise<() => Promise<void>> {
  let active = true
  const writer = createMissionWriterRetirement(), registrations: Registration[] = []
  const assertActive = () => { if (!active) throw new Error("CodeNomad Missions is no longer available") }
  const tracked = <Args extends unknown[], Result>(callback: (...args: Args) => Promise<Result>) =>
    (...args: Args) => writer.run(() => callback(...args))
  const route = async (sessionID: string, name: Parameters<MissionsPluginPolicy["beforeTool"]>[0], input: unknown) => {
    assertActive()
    const selected = await select(sessionID)
    if (!selected) throw new Error("CodeNomad Missions is no longer available")
    selected.current()
    await selected.beforeTool(name, input)
    assertActive(); selected.current()
    return selected
  }
  // Interrupt receipts too large for one result, for exact receipt reads, for this
  // registration's lifetime and within their byte budget (`InterruptReceipts`).
  const receipts = new InterruptReceipts()
  const dispose = async () => {
    active = false
    await writer.retire(async () => { await Promise.all(registrations.map(registration => registration.dispose())) })
    receipts.clear()
  }
  try {
    const tools = await context.tool.transform((draft) => {
      const add = (definition: Parameters<ToolDraft["add"]>[0]) => draft.add({ ...definition, execute: tracked(definition.execute) })
      draft.namespace({
        name: "mission",
        description: "Declare bounded native tasks and explicit independent-session exceptions through one durable business mission map.",
      })
      add({
        name: "inspect",
        description: "Inspect the caller's durable mission map and optional native catalog, or prepare a paused custom, debugging, Wayfinder, product delivery, or two-model comparison mission. The user presses Play in CodeNomad before Mission work begins; creation never sends a coordinator prompt. Compare requires different model-a/model-b profiles and always a blind judge. Pass taskKey to read only that task with its revision, frontier, contract, exact current assignmentPrompt, observed native conversations and any qualifying human answers instead of the full map. A map too large for one result lists its tasks in pages: follow taskPage.nextTaskOffset with taskOffset. Any value too large for one result is replaced by { omittedCharacters, read }: pass read as the whole input to read that value in slices, following each slice's next. Pass list: true to find your missions and prepared hand-offs; missionID also reads a hand-off you prepared.",
        input: inspectSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "inspect", input)
          await tool.progress({ status: "Reading the mission map" })
          selected.current()
          const parsed = parseInspectInput(input)
          if (parsed.list) return textResult(boundedMissionList(await executeMissionBusiness(selected, control => control.listMissions(selected.readSessionID)), parsed.listOffset))
          const read = parsed.content
          // The caller's Location's native catalog, read afresh on every call.
          const catalog = async () => readMissionCatalog(context, (await context.session.get({ sessionID: tool.sessionID })).location.directory)
          // A catalog read selects no mission: only the owned-root checks, no journal read.
          if (read?.kind === "catalog") {
            await executeMissionBusiness(selected, control => control.ownedRoot(selected.readSessionID))
            selected.current()
            return textResult(inspectionContent(undefined, read, await catalog()))
          }
          // A receipt read serves the held original interrupt result to the coordinator that received it.
          if (read?.kind === "receipt") {
            await executeMissionBusiness(selected, control => control.ownedRoot(selected.readSessionID))
            selected.current()
            const held = receipts.read(tool.sessionID, read.digest)
            if (held === undefined) throw new Error("This interruption receipt is no longer held: each task keeps only its newest one,"
              + " within the plugin's receipt budget, until the plugin reloads")
            return textResult(inspectionContent(undefined, read, held))
          }
          const result = await executeMissionBusiness(selected, control => control.inspect(selected.readSessionID, parsed, tool.id))
          const response = parsed.taskKey === undefined ? result
            : await executeMissionBusiness(selected, control => observedTaskView(control, selected.readSessionID, result.mission, parsed.taskKey!))
          if (object(input).catalog === true) response.catalog = await catalog()
          if (read) {
            if (!result.mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
            const value = read.kind === "task" && (MISSION_TASK_VIEW_FIELDS as readonly string[]).includes(read.field)
              ? taskViewField(await executeMissionBusiness(selected, control => observedTaskView(control, selected.readSessionID, result.mission, read.taskKey)), read)
              : inspectionContentValue(result, read)
            return textResult(inspectionContent(result.mission.id, read, value))
          }
          return textResult(parsed.taskKey === undefined ? boundedInspection(result, parsed.taskOffset)
            : boundedTaskView(response as Record<string, unknown>, result.mission!, parsed.taskKey))
        },
      })
      add({
        name: "delegate",
        description: "Declare one dependency-aware native task without creating or prompting a session. Pass the returned canonical assignmentPrompt to ordinary native subagent calls for ready tasks; run independent ready work in parallel when useful and let children own bounded recursive decomposition within native permissions and configured depth. The coordinator records business readout with mission.report and taskKey, without child report copies or invocation bindings. Explicit independent execution requires a reason and may dispatch a root exception. Coordinator only; inspect the native catalog before selecting agent/model IDs. Returns a compact result: disposition, revision, frontier, the task, its contract and assignmentPrompt, and any role requirement; mission.inspect with taskKey rereads the prompt. A result too large for one call replaces its assignmentPrompt or frontier by { omittedCharacters, read }: read it whole with mission.inspect(read), following each slice's next, and pass the joined prompt; never pass the marker or part of the prompt as an assignment.",
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
          const selected = await route(tool.sessionID, independent ? "delegate" : "declare", input)
          await tool.progress({ status: independent ? "Delegating independent mission task" : "Declaring native mission task" })
          selected.current()
          if (independent) {
            const parsed = parseDelegateInput(input)
            const result = await executeMissionBusiness(selected, control => control.delegate(tool.sessionID, parsed))
            return textResult(boundedMutation({ disposition: result.disposition, ...compactMission(result.mission),
              task: compactMissionTasks(result.mission, [parsed.taskKey])[0] }, result.mission))
          }
          const result = await executeMissionBusiness(selected, control => control.declare(tool.sessionID, normalizeTaskDeclaration({ ...value, blockedBy: value.blockedBy ?? [] })))
          const task = result.mission.tasks.find(candidate => candidate.key === result.contract.taskKey)
          if (!task || task.executionMode?.kind !== "native" || task.contractGeneration !== result.contract.generation) {
            throw new MissionControlError("Declared native task context unavailable", "invalid-journal")
          }
          return textResult(boundedMutation({ disposition: result.disposition, ...compactMission(result.mission), task: compactMissionTask(task),
            ...nativeAssignment(result.mission, task) }, result.mission))
        },
      })
      add({
        name: "revise",
        description: "Revise the current mission plan with a reason and expected revision. Coordinator only. Add newly discovered work, retire/replace tasks or rewrite dependencies atomically; this does not cancel already admitted native execution. Returns the new revision, frontier and the added, retired or rewired tasks; mission.inspect returns the full map.",
        input: reviseSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "revise", input)
          await tool.progress({ status: "Revising mission plan" })
          selected.current()
          const revision = parseReviseInput(input)
          const { mission } = await executeMissionBusiness(selected, control => control.revise(tool.sessionID, revision))
          return textResult(boundedRevision(mission, [...revision.addTasks,
            ...revision.retireTasks, ...revision.dependencyUpdates].map(item => item.taskKey)))
        },
      })
      add({
        name: "report",
        description: "Coordinator: settle a declared native task with taskKey and actual returned evidence from ordinary native work, including any child-owned recursive helpers; do not ask descendants for duplicate mission reports. Finalize when the plan is complete. This business readout does not prove native execution ended or human consent. Independent-root actors report their assigned tasks as before. Qualified native actors may optionally supply an exact contract through the stronger native-return route. Only the coordinator may finalize. The summary is shown to the human: plain language in the user's language, 3-5 short sentences, outcome first, no session/message IDs, internal tool or fixture names; put IDs, commands and test output only in evidence. A final summary states what was delivered, what remains and what needs a decision in at most 6 sentences. Returns the disposition, new revision, frontier and reported task; mission.inspect returns the full map.",
        input: reportSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "report", input)
          await tool.progress({ status: "Recording mission report" })
          selected.current()
          const report = parseReportInput(input)
          const reference = object(input).contract
          const contract = reference === undefined ? undefined : taskContractReferenceSchema.parse(reference)
          const result = await executeMissionBusiness(selected, control => contract === undefined ? control.report(tool.sessionID, report)
            : control.reportNative({ contract, sessionID: tool.sessionID, toolCallID: tool.id, messageID: tool.messageID }, report))
          // The control names the task it resolved, including an independent actor's omitted taskKey.
          return textResult(boundedMutation({ disposition: result.disposition, ...compactMission(result.mission),
            ...(result.taskKey === undefined ? {} : { task: compactMissionTasks(result.mission, [result.taskKey])[0] }) }, result.mission))
        },
      })
      add({
        name: "briefing",
        description: "Coordinator only: publish a short user-facing project briefing, separate from task results and observed activity. Pass the current revision as basedOnRevision: every mission tool result returns it, or inspect the mission. Explain usable achievements, remaining work, obstacles and the next step in plain language in the user's language: 3-5 short sentences, outcome first, no session/message IDs, internal tool or fixture names; reference exact live task keys only in taskKeys. Publish unprompted after the initial plan, after settling each task, when starting to wait on a human and before the final report, with requestID \"auto:<revision>\" matching basedOnRevision; for an explicit UI request use its exact requestID. requestID \"auto\" without basedOnRevision lets the server pick the current revision and refuses a duplicate when nothing changed. A briefing does not settle tasks, grant human consent, change the plan or finish the mission. On a revision conflict reread before publishing, never replay work. Returns the new revision and frontier.",
        input: missionBriefingToolSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "briefing", input)
          await tool.progress({ status: "Recording project briefing" })
          selected.current()
          const { mission } = await executeMissionBusiness(selected, control => control.briefing(tool.sessionID, parseMissionBriefingRequest(input)))
          return textResult(boundedMutation(compactMission(mission), mission))
        },
      })
      add({
        name: "interrupt",
        description: "Coordinator only: stop the native conversations still running for a retired native task. Retire it with mission.revise first. Each task conversation's whole native family is interrupted deepest first and its queued inputs are cancelled; the coordinator and the plan stay unchanged. complete false means some work may still be running. A receipt too large for one result keeps complete, the totals and each conversation's outcome with its descendant counts, and names in receipt the read of the whole original receipt: mission.inspect(receipt.read), held for each task's newest interruption within the plugin's receipt budget until evicted or the plugin reloads; a read it no longer holds is refused.",
        input: interruptSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "interrupt", input)
          await tool.progress({ status: "Stopping retired task work" })
          selected.current()
          const { target, ...result } = await executeMissionBusiness(selected, control => control.interruptTask(tool.sessionID, parseInterruptInput(input)))
          // The task's slot is the identity the interruption resolved; its newest result always replaces the previous receipt.
          const slot = JSON.stringify([tool.sessionID, target.missionID, target.taskKey])
          const bounded = boundedInterruption(result, receipt => receipts.hold(tool.sessionID, slot, receipt))
          if (bounded === result) receipts.retire(slot)
          return textResult(bounded)
        },
      })
      add({
        name: "prepare",
        description: "Coordinator only: prepare a separate paused one-time mission, such as a pilot hand-off, from an objective, optional title and notes, a template, profiles and task mode: what the Mission editor creates. It never starts; the user presses Play. Reuse the same requestID to retry. Find it later with mission.inspect({ list: true }) and read it with mission.inspect({ missionID }); you cannot control it.",
        input: prepareSchema,
        options: { namespace: "mission", codemode: false },
        execute: async (input, tool) => {
          assertActive()
          const selected = await route(tool.sessionID, "prepare", input)
          await tool.progress({ status: "Preparing a paused mission" })
          selected.current()
          const { mission } = await executeMissionBusiness(selected, control => control.prepare(tool.sessionID, parsePrepareInput(input)))
          return textResult({ disposition: "prepared", missionID: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }),
            status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }), revision: mission.revision })
        },
      })
    })
    registrations.push(tools)

    // Ordinary native sub-agents of a one-time Mission are not actors and read no
    // Mission context; a paused Mission still reaches them through their ancestry.
    // Cached parent IDs only find the candidate actor cheaply (running Missions and
    // unrelated families need no native read once warm). Placement can change with
    // a native move, so a paused candidate's whole chain is re-read: every session
    // must still link to its parent and share the actor's admitted project and Location.
    const parents = new Map<string, string | null>()
    const parentOf = async (sessionID: string) => {
      let parent = parents.get(sessionID)
      if (parent === undefined) {
        const session = await context.session.get({ sessionID })
        parent = session.id === sessionID ? session.parentID ?? null : null
        if (parents.size >= MAX_PAUSE_ANCESTRY_CACHE) parents.delete(parents.keys().next().value!)
        parents.set(sessionID, parent)
      }
      return parent
    }
    const pausedAncestorMission = async (control: MissionBusinessRoute["control"], sessionID: string): Promise<string | undefined> => {
      const chain = [sessionID]
      let mission: Awaited<ReturnType<typeof control.contextFor>>
      while (!mission) {
        if (chain.length > MAX_PAUSE_ANCESTRY) return undefined
        const parent = await parentOf(chain.at(-1)!)
        if (!parent || chain.includes(parent)) return undefined
        chain.push(parent)
        mission = await control.contextFor(parent)
      }
      if (!mission.paused) return undefined
      const { projectID, location } = mission.placement
      for (const [index, id] of chain.entries()) {
        const session = await context.session.get({ sessionID: id })
        if (session.id !== id || session.projectID !== projectID || !sameLocation(session.location, location)
          || (index < chain.length - 1 && session.parentID !== chain[index + 1])) return undefined
      }
      return mission.missionID
    }

    const contextHook = await context.session.hook("context", (event) => {
      if (!active) return
      return writer.run(async () => {
        try {
          const selected = await select(event.sessionID)
          if (!selected) {
            for (const name of ["inspect", ...COORDINATOR_TOOLS, "report"]) delete event.tools[`mission_${name}`]
            return
          }
          selected.current()
          // One hinted membership read per turn: the instruction and the coordinator check share it.
          const mission = await executeMissionBusiness(selected, control => control.contextFor(selected.readSessionID))
          if (active && !mission && selected.readSessionID === event.sessionID) {
            const paused = await executeMissionBusiness(selected, control => pausedAncestorMission(control, event.sessionID))
            if (active && paused) {
              selected.current()
              event.system.push({ type: "text", text: missionPausedInstruction(paused, true) })
            }
          }
          if (!active || !mission) return
          selected.current()
          if (selected.readSessionID !== event.sessionID) {
            event.system.push({ type: "text", text: `You are a native descendant of coordinator ${selected.readSessionID}. Return normal scoped results to your immediate parent; only the coordinator declares, revises, reports or finalizes the business plan. mission.inspect is read-only.` })
            // A paused mission's sub-agents stop after their current step too.
            if (mission.paused) event.system.push({ type: "text", text: missionPausedInstruction(mission.missionID, true) })
            for (const name of [...COORDINATOR_TOOLS, "report"]) delete event.tools[`mission_${name}`]
            return
          }
          event.system.push({ type: "text", text: mission.instruction })
          // Scheduled passages have no backend route for these actions: do not offer them.
          if (!await executeMissionBusiness(selected, async control => control.backendActions))
            for (const name of ["interrupt", "prepare"]) delete event.tools[`mission_${name}`]
          if (!mission.coordinator) for (const name of COORDINATOR_TOOLS) delete event.tools[`mission_${name}`]
        } catch {
          // Mission context is additive. A damaged optional map must not block an otherwise valid model request.
        }
      })
    })
    registrations.push(contextHook)
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}

/** Topology and hand-off tools only the coordinator itself may see. */
const COORDINATOR_TOOLS = ["delegate", "revise", "briefing", "interrupt", "prepare"] as const
/** Native nesting levels walked to find a paused Mission actor, and sessions whose parent is remembered. */
const MAX_PAUSE_ANCESTRY = 32
const MAX_PAUSE_ANCESTRY_CACHE = 4096

const interruptSchema = {
  type: "object",
  properties: {
    missionID: { type: "string", maxLength: 100 },
    taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$", description: "A retired native task launched by the coordinator." },
  },
  required: ["taskKey"],
  additionalProperties: false,
}

const prepareSchema = {
  type: "object",
  properties: {
    requestID: { type: "string", minLength: 1, maxLength: 64, description: "Stable ID for this hand-off; reuse it to retry without creating a second mission." },
    objective: { type: "string", minLength: 1, maxLength: 20_000 },
    title: { type: "string", minLength: 1, maxLength: MISSION_TITLE_MAX },
    notes: { type: "string", maxLength: 20_000 },
    template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
    profiles: missionProfilesSchema,
    taskMode: missionTaskModeSchema,
  },
  required: ["requestID", "objective", "template"],
  additionalProperties: false,
}

export function parseInterruptInput(input: unknown): { missionID?: string; taskKey: string } {
  const value = object(input)
  return { missionID: optionalText(value.missionID, "missionID", 100), taskKey: identifier(value.taskKey, "taskKey") }
}

export function parsePrepareInput(input: unknown): MissionPrepareRequest {
  const value = object(input)
  const template = requiredText(value.template, "template", 40)
  if (!isTemplate(template)) throw new Error("template is unsupported")
  return {
    requestID: requiredText(value.requestID, "requestID", 64),
    objective: requiredText(value.objective, "objective", 20_000),
    ...(value.title === undefined ? {} : { title: missionTitle(value.title) }),
    ...(value.notes === undefined ? {} : { notes: optionalBodyText(value.notes, "notes", 20_000) }),
    template,
    taskMode: parseMissionTaskMode(value.taskMode),
    ...(value.profiles === undefined ? {} : { profiles: parseMissionProfiles(value.profiles) }),
  }
}

const inspectSchema = {
  type: "object",
  properties: {
    missionID: { type: "string", description: "Mission to inspect; omit to use the caller's active mission." },
    taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$", description: "Read only this task: its status, revision, frontier and, for a live native task, its contract, exact current assignmentPrompt, observed native conversations and, for a Wayfinder decision, the qualifying human answers with ready-to-pass artifacts. Not with start." },
    taskOffset: { type: "integer", minimum: 0, description: "Read the map's tasks from this position when the map is too large for one result: its taskPage gives nextTaskOffset. Not with taskKey, list or start." },
    list: { type: "boolean", const: true, description: "List the missions you belong to and the hand-offs you prepared, newest first. Use alone, or with listOffset." },
    listOffset: { type: "integer", minimum: 0, description: "With list: read the list from this position when it is too large for one result: its listPage gives nextListOffset." },
    content: {
      type: "object",
      description: "Read one slice of a value a result replaced by { omittedCharacters, read }: pass that read as the whole input, then each slice's next. A slice of a value that changed since the read began is refused: inspect again for its current read.",
      properties: {
        kind: { type: "string", enum: ["inspection", "mission", "task", "report", "change", "catalog", "receipt"] },
        field: { type: "string", minLength: 1, maxLength: 64 },
        taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
        reportId: { type: "string", minLength: 1, maxLength: 240 },
        change: { type: "integer", minimum: 1 },
        revision: { type: "integer", minimum: 1 },
        digest: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["kind", "digest", "offset"],
      additionalProperties: false,
    },
    catalog: { type: "boolean", description: "Include the native agent, enabled model and variant catalog for this session's location." },
    start: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 20_000 },
        template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
        notes: { type: "string", maxLength: 20_000 },
        profiles: missionProfilesSchema,
        taskMode: { ...missionTaskModeSchema, description: "Declared task policy for this new mission only; omitted defaults to native. Independent requires explicit reasoned independent declarations, not a native-helper ban or new-root authorization." },
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
    executionMode: { ...taskExecutionModeSchema, description: "Omit for a native task under the coordinator in native-mode missions. Independent-mode missions require kind independent and a concrete reason/explanation; the persisted user-selected policy may justify reason playbook. Native parent/reuse references are explicit. This does not authorize new roots or bypass helper permissions/depth." },
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
    artifact: { description: "Optional structured playbook evidence. Required for completed Debugging tasks and Compare comparator reports. Compare uses a version 1 comparison with completed model-a/model-b runRefs, criterion scores for both, evidence and verdict a, b, equivalent or inconclusive; run roles return ordinary output without artifacts. A completed Wayfinder decision readout passes your own decision ({kind: decision, decidedBy: coordinator, question, decision, rationale}), or omits the artifact once the human answered a question ending with the task's questionTag and naming no other decision (when several answers qualify, pass the one mission.inspect({ taskKey }) lists, unchanged)." },
    final: { type: "boolean", description: "Coordinator-only terminal mission report. A one-time mission finishes only as completed; when nothing can proceed without the human, ask them with the native question tool instead of finishing." },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
}

export function parseInspectInput(input: unknown): MissionInspectInput & {
  taskKey?: string; list?: true; taskOffset?: number; listOffset?: number; content?: MissionInspectContent
} {
  const value = object(input)
  const missionID = optionalText(value.missionID, "missionID", 100)
  if (value.content !== undefined) {
    if (value.list !== undefined || value.taskKey !== undefined || value.start !== undefined || value.taskOffset !== undefined
      || value.listOffset !== undefined || value.catalog !== undefined) throw new Error("content reads one value; use it with missionID only")
    const content = parseInspectContent(value.content)
    if ((content.kind === "catalog" || content.kind === "receipt") && missionID !== undefined) throw new Error(`A ${content.kind} read names no mission: pass its read as the whole input`)
    return { missionID, content }
  }
  if (value.taskOffset !== undefined) {
    if (!Number.isSafeInteger(value.taskOffset) || Number(value.taskOffset) < 0) throw new Error("taskOffset must be a non-negative integer")
    if (value.list !== undefined || value.taskKey !== undefined || value.start !== undefined) throw new Error("taskOffset pages an existing map; use it without taskKey, list or start")
    return { missionID, taskOffset: Number(value.taskOffset) }
  }
  if (value.list !== undefined) {
    if (value.list !== true || value.taskKey !== undefined || value.start !== undefined || missionID !== undefined) {
      throw new Error("list must be true and used alone or with listOffset")
    }
    if (value.listOffset === undefined) return { list: true }
    if (!Number.isSafeInteger(value.listOffset) || Number(value.listOffset) < 0) throw new Error("listOffset must be a non-negative integer")
    return { list: true, listOffset: Number(value.listOffset) }
  }
  if (value.listOffset !== undefined) throw new Error("listOffset pages list: true")
  if (value.taskKey !== undefined) {
    if (value.start !== undefined) throw new Error("taskKey reads an existing mission and cannot start one")
    return { missionID, taskKey: identifier(value.taskKey, "taskKey") }
  }
  if (value.start === undefined) return { missionID }
  const start = object(value.start)
  const template = requiredText(start.template, "start.template", 40)
  if (!isTemplate(template)) throw new Error("start.template is unsupported")
  return {
    missionID,
    start: {
      objective: requiredText(start.objective, "start.objective", 20_000),
      template,
      taskMode: parseMissionTaskMode(start.taskMode),
      notes: optionalText(start.notes, "start.notes", 20_000),
      ...(start.profiles === undefined ? {} : { profiles: parseMissionProfiles(start.profiles) }),
    },
  }
}

function parseInspectContent(input: unknown): MissionInspectContent {
  const value = object(input)
  if (typeof value.digest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.digest) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
    throw new Error("content needs its digest and a non-negative offset")
  }
  const read = { digest: value.digest, offset: Number(value.offset) }
  if (value.kind === "catalog" || value.kind === "receipt") {
    if (value.field !== undefined || value.revision !== undefined || value.taskKey !== undefined || value.reportId !== undefined || value.change !== undefined) {
      throw new Error(`A ${value.kind} read has only its digest and offset`)
    }
    return { kind: value.kind, ...read }
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error("content needs the positive revision of its map")
  const base = { field: requiredText(value.field, "content.field", 64), revision: Number(value.revision), ...read }
  if (value.kind === "inspection" || value.kind === "mission") return { kind: value.kind, ...base }
  if (value.kind === "task") return { kind: "task", taskKey: identifier(value.taskKey, "content.taskKey"), ...base }
  if (value.kind === "report") return { kind: "report", reportId: requiredText(value.reportId, "content.reportId", 240), ...base }
  if (value.kind === "change") {
    if (!Number.isSafeInteger(value.change) || Number(value.change) < 1) throw new Error("content.change must be a positive revision")
    return { kind: "change", change: Number(value.change), ...base }
  }
  throw new Error("content.kind is unsupported")
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
    // One update per distinct live task, checked against the map.
    dependencyUpdates: {
      type: "array", items: {
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
    ...(value.title === undefined ? {} : { title: missionTitle(value.title) }),
    objective: requiredText(value.objective, "objective", 20_000),
    notes: optionalBodyText(value.notes, "notes", 20_000),
    template,
    taskMode: parseMissionTaskMode(value.taskMode),
    ...(value.profiles === undefined ? {} : { profiles: parseMissionProfiles(value.profiles) }),
    coordinatorSessionID: optionalText(value.coordinatorSessionID, "coordinatorSessionID", 240),
    ...(value.expectedCoordinatorLocation === undefined ? {} : { expectedCoordinatorLocation: readLocationRef(value.expectedCoordinatorLocation) }),
    ...(value.preparedBy === undefined ? {} : { preparedBy: (preparedBy => ({
      missionID: requiredText(preparedBy.missionID, "preparedBy.missionID", 100),
      coordinatorSessionID: requiredText(preparedBy.coordinatorSessionID, "preparedBy.coordinatorSessionID", 240),
    }))(object(value.preparedBy)) }),
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
    brief: briefText(value.brief, value.role, "brief"),
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

/** One task of the selected mission, without the full map: the exact prompt survives saved tool
 * output. Native conversations and qualifying human answers are advisory reads that may be unknown. */
async function observedTaskView(control: MissionBusinessControl, sessionID: string, mission: MissionBusinessMutationMap | null, taskKey: string): Promise<Record<string, unknown>> {
  const task = mission?.tasks.find(candidate => candidate.key === taskKey)
  if (!mission || !task) throw new MissionControlError(`Mission task not found: ${taskKey}`, "task-not-found")
  const [native, answers] = await Promise.allSettled([control.observeTask(sessionID, mission.id, taskKey),
    control.decisionCandidates(sessionID, mission.id, taskKey)])
  return { ...compactMission(mission), task: compactMissionTask(task), ...nativeAssignment(mission, task),
    reports: mission.reports.filter(report => report.taskKey === taskKey),
    ...(native.status === "rejected" ? { native: { unknown: true } } : native.value
      ? { native: native.value.sessions.length ? native.value : { ...native.value, note: NO_TASK_CONVERSATION } } : {}),
    ...(answers.status === "rejected" ? { humanAnswers: { unknown: true } } : answers.value ? { humanAnswers: answers.value } : {}) }
}

/** A `taskKey` view value a content read names, from a view of the same revision. */
function taskViewField(view: Record<string, unknown>, read: Extract<MissionInspectContent, { kind: "task" }>): unknown {
  if (view.revision !== read.revision) throw new Error("Mission changed since this page: read it again from its first page")
  if (!Object.prototype.hasOwnProperty.call(view, read.field)) throw new Error("Mission content unavailable")
  return view[read.field]
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

function briefText(value: unknown, role: unknown, name: string): string {
  const normalized = requiredText(value, name, 20_000)
  // Compare's run briefs must reach the equality check byte-for-byte.
  return typeof role === "string" && ["model-a", "model-b"].includes(role.trim()) ? value as string : normalized
}

function missionTitle(value: unknown): string {
  const title = parseMissionTitle(value)
  if (title === undefined) throw new Error(`title must be a single line of 1–${MISSION_TITLE_MAX} characters`)
  return title
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
  if (!Array.isArray(dependencyUpdates)) throw new Error("dependencyUpdates must be an array")
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
      brief: briefText(entry.brief, entry.role, `addTasks[${index}].brief`),
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
  return value === "custom" || value === "debug" || value === "wayfinder" || value === "delivery" || value === "compare"
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
