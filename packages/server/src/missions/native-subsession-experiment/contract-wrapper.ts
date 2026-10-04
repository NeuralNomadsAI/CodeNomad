import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { z } from "zod"
import { MissionJournal, stableToken } from "../journal"
import { runMissionExclusive } from "../exclusive"
import { validateMissionReportArtifact } from "../contracts"
import type { MissionEvent, MissionJsonValue } from "../model"
import { createNativeContractPlans, Ref, type Binding } from "./contract-plan"
import { assertActualExecution, prepareNativeContractExecution } from "./contract-execution"
import { createNativeActorCapacityReservations, type NativeActorCapacityReservation } from "./contract-capacity"

const Report = z.object({ contract: Ref, outcome: z.enum(["completed", "blocked", "failed"]), summary: z.string().min(1).max(20000), artifact: z.unknown().optional() }).strict()
const RefSchema = Schema.Struct({ missionID: Schema.String, revision: Schema.Number, taskKey: Schema.String })
type EventPayload = MissionEvent extends infer E ? E extends MissionEvent ? Omit<E, "version" | "missionID" | "projectID" | "id" | "createdAt"> : never : never
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as MissionJsonValue
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// Local admission claims refuse delayed busy continuations. They are not a
// durable execution claim or cross-process native-writer exclusion.
const taskFlights = new Map<string, symbol>()

/** Experimental private-plugin seam. No production registration or root-authority changes.
 * Interface: install once; seed/revise only from authenticated coordinator admission;
 * inspect is read-only. Native subagent({ ...nativeInput, mission: ref }) and
 * mission_contract_report({ contract: ref, outcome, summary }) are model-facing.
 * Task generation, mutable plan revision and journal event revision are distinct.
 */
export async function installNativeMissionContracts(ctx: Plugin.Context, options: { assertNativeIdle?: (sessionID: string) => Promise<void> } = {}) {
  const prefix = "private-native-contract/v1/"
  const journal = new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical)
  const exclusive = <T>(fn: () => Promise<T>) => runMissionExclusive(prefix + journal.projectToken, fn)
  const key = (suffix: string) => prefix + suffix
  const get = async <T>(suffix: string) => await ctx.storage.get(key(suffix)) as T | undefined
  const set = (suffix: string, value: unknown) => ctx.storage.set(key(suffix), json(value))
  const event = async (missionID: string, identity: string, payload: EventPayload) => {
    // ponytail: one private project lock; no native executor is awaited under it.
    const previous = await get<number>("clock") ?? 0
    const createdAt = Math.max(Date.now(), previous + 1)
    await set("clock", createdAt)
    await journal.append({ version: 1, missionID, projectID: ctx.location.project.id,
      id: "evt_" + stableToken(missionID + "\0" + identity, 32), createdAt, ...payload } as MissionEvent)
  }
  let active = true
  const assertActive = () => { if (!active) throw new Error("Contract wrapper disposed; native mutation not replayed") }
  const contractPlans = createNativeContractPlans({ get, set, event, snapshot: () => journal.snapshot(), session: ctx.session, location: ctx.location, assertActive })
  const { planFor, admitted } = contractPlans
  const capacity = createNativeActorCapacityReservations(ctx.location.project.id)
  const nativeBinding = (binding: Binding) => ({ generation: binding.revision, parentSessionID: binding.parentID, toolCallID: binding.callID, parentMessageID: binding.messageID })
  const registrations: Array<{ dispose(): Promise<void> }> = []
  let nativeFieldsPreserved = false
  registrations.push(await ctx.session.hook("context", async draft => {
    assertActive()
    const binding = await get<Binding>("current/" + draft.sessionID)
    if (binding) {
      const child = await ctx.session.get({ sessionID: draft.sessionID })
      if (child.parentID !== binding.parentID || child.id !== binding.childID) throw new Error("Contract child context identity mismatch")
      const { plan, task } = await planFor(binding)
      assertActualExecution(task.execution, { agent: draft.agent, model: draft.model })
      draft.system.push({ type: "text", text: "MISSION_NATIVE_CONTRACT:" + JSON.stringify(binding) })
      const dependencies = await Promise.all(task.blockedBy.map(async taskKey => ({ taskKey,
        outcome: (await get<{ outcome: string }>("report/" + plan.missionID + "/" + taskKey))?.outcome ?? null })))
      draft.system.push({ type: "text", text: "MISSION_NATIVE_TASK:" + JSON.stringify({ objective: plan.objective, task, dependencies }) })
      await set("context-prepared/" + binding.parentID + "/" + binding.callID, binding)
    }
  }))
  registrations.push(await ctx.tool.transform(editor => {
    editor.namespace({ name: "mission_contract", description: "Explicit native child business reports, separate from native tool outcomes" })
    editor.add({ name: "report", description: "Acknowledge exactly the current Mission contract. Does not send another parent notification.",
      input: Schema.Struct({ contract: RefSchema, outcome: Schema.Literals(["completed", "blocked", "failed"]), summary: Schema.String, artifact: Schema.optionalKey(Schema.Unknown) }), options: { namespace: "mission_contract", codemode: false }, execute: async (raw, tool) => exclusive(async () => {
        assertActive(); tool.signal.throwIfAborted()
        const input = Report.parse(raw)
        const binding = await get<Binding>("current/" + tool.sessionID)
        if (!binding || !equal(input.contract, { missionID: binding.missionID, revision: binding.revision, taskKey: binding.taskKey })) throw new Error("Report must match exact current native child contract")
        const child = await ctx.session.get({ sessionID: tool.sessionID })
        if (child.parentID !== binding.parentID) throw new Error("Report caller native parent mismatch")
        const { task } = await planFor(input.contract, { historical: true })
        const late = !await contractPlans.isCurrent(input.contract)
        const artifact = validateMissionReportArtifact({ template: "custom", role: task.role, outcome: input.outcome, artifact: input.artifact as MissionJsonValue })
        const id = "report_" + stableToken(binding.missionID + "\0" + binding.taskKey + "\0" + binding.revision + "\0" + binding.childID, 32)
        const report = { id, contract: input.contract, sessionId: tool.sessionID, outcome: input.outcome, summary: input.summary, ...(late ? { late: true } : {}), ...(artifact === undefined ? {} : { artifact }) }
        const previous = await get("report/" + binding.missionID + "/" + binding.taskKey)
        if (previous && !equal(previous, report)) throw new Error("Immutable business report conflict")
        if (!previous) {
          await event(binding.missionID, id, { type: "task.reported", report: { ...report, taskKey: binding.taskKey, evidence: [], next: [], createdAt: Date.now() } })
          await set("report/" + binding.missionID + "/" + binding.taskKey, report)
        }
        return { content: JSON.stringify({ businessAcknowledged: true, reportID: id, contract: input.contract }), metadata: { reportID: id } }
      }) })
    editor.update("subagent", definition => {
      const native = definition.execute
      const original = Object.entries(definition).filter(([field]) => field !== "input" && field !== "execute")
      const input = definition.input as unknown as Schema.Struct<Schema.Struct.Fields>
      if (!input.mapFields) throw new Error("Native schema is not an extensible Struct; no fallback raw executor")
      definition.input = input.mapFields(fields => ({ ...fields, mission: Schema.optionalKey(RefSchema) }))
      definition.execute = async (raw, tool) => {
        assertActive(); tool.signal.throwIfAborted()
        const { mission, ...nativeInput } = raw as Record<string, unknown>
        if (mission === undefined) return native(raw, tool)
        const ref = Ref.parse(mission)
        // ponytail: reject invalid ancestry before it can wait on its own ancestor's lock.
         await admitted(ref, tool.sessionID)
         const flightKey = prefix + journal.projectToken + "/task/" + ref.missionID + "/" + ref.taskKey
         if (taskFlights.has(flightKey)) throw new Error("Contract task has a native call in flight")
         const flight = Symbol("native-task-call")
         taskFlights.set(flightKey, flight)
        // ponytail: serialize only this task's native calls; recursive tasks and
        // different siblings stay parallel. Crash-atomic admission is unqualified.
         try { return await runMissionExclusive(flightKey, async () => {
          assertActive(); tool.signal.throwIfAborted()
          const admission = await admitted(ref, tool.sessionID)
          if (nativeInput.background === true) throw new Error("Background not qualified by this foreground contract adapter")
          const owner = await get<Binding>("owner/" + ref.missionID + "/" + ref.taskKey)
          if (owner && typeof nativeInput.sessionID !== "string") throw new Error("Contract already has a native actor; continue its exact child")
          if (owner && nativeInput.sessionID !== owner.childID) throw new Error("Contract continuation must use its exact native actor")
          const prepared = await prepareNativeContractExecution(ctx, admission.task, ref, tool.sessionID, nativeInput, {
            readCurrent: sessionID => get<Binding>("current/" + sessionID),
            readReport: previous => get("report/" + previous.missionID + "/" + previous.taskKey),
            readReturned: previous => get("returned/" + previous.parentID + "/" + previous.callID),
            assertNativeIdle: async sessionID => {
              if (!options.assertNativeIdle) throw new Error("Authoritative native idle observation unavailable")
              await options.assertNativeIdle(sessionID)
            },
          })
          let binding: Binding | undefined
           let firstBinding = false
           let projected = false
           let slot: NativeActorCapacityReservation | undefined
          try {
            await exclusive(async () => {
              assertActive(); tool.signal.throwIfAborted()
               await admitted(ref, tool.sessionID)
               const mission = (await journal.snapshot()).missions.find(mission => mission.id === ref.missionID)
               if (!mission) throw new Error("Native actor capacity Mission unavailable")
               slot = capacity.reserve(mission, typeof nativeInput.sessionID === "string" ? nativeInput.sessionID : undefined)
              await prepared.revalidateBeforeNative()
              await admitted(ref, tool.sessionID)
            })
             let result: Awaited<ReturnType<typeof native>>
             try { result = await native(nativeInput, { ...tool, progress: async update => {
              assertActive(); tool.signal.throwIfAborted()
              if (typeof update.sessionID === "string") await exclusive(async () => {
                const now = await admitted(ref, tool.sessionID)
                await prepared.assertProgressChild(update.sessionID)
                const child = await ctx.session.get({ sessionID: update.sessionID })
                if (child.parentID !== tool.sessionID || child.location.directory !== ctx.location.directory) throw new Error("Structured progress native parent/location mismatch")
                const owner = await get<Binding>("owner/" + ref.missionID + "/" + ref.taskKey)
                binding = { ...ref, parentID: tool.sessionID, childID: child.id, callID: tool.id, messageID: tool.messageID, depth: now.depth }
                if (owner && (owner.childID !== child.id || owner.parentID !== tool.sessionID)) throw new Error("Contract already has a different native actor")
                const existing = await get<Binding>("binding/" + tool.sessionID + "/" + tool.id)
                if (existing && !equal(existing, binding)) throw new Error("Actual native call ID collision")
                if (!existing) {
                   const mission = (await journal.snapshot()).missions.find(mission => mission.id === ref.missionID)
                   if (!owner) {
                    const title = mission?.actors.find(actor => actor.sessionId === child.id)?.title ?? child.title ?? child.id
                    await event(ref.missionID, "binding-" + tool.sessionID + "-" + tool.id, { type: "task.native-bound", taskKey: ref.taskKey, actor: { sessionID: child.id, title, location: child.location, managed: false }, binding: nativeBinding(binding) })
                     firstBinding = true
                   } else await event(ref.missionID, "started-" + tool.sessionID + "-" + tool.id, { type: "task.native-call-started", taskKey: ref.taskKey, childSessionID: child.id, binding: nativeBinding(binding) })
                   const acceptedSnapshot = await journal.snapshot()
                   const accepted = acceptedSnapshot.missions.find(mission => mission.id === ref.missionID)?.tasks.find(task => task.key === ref.taskKey)
                   if (acceptedSnapshot.discardedEvents || accepted?.actorSessionId !== child.id || !accepted.nativeExecution || !equal(accepted.nativeExecution.binding, nativeBinding(binding)) || accepted.nativeExecution.ended) {
                     throw new Error("Native invocation binding was not accepted by the Mission journal")
                   }
                   if (!slot) throw new Error("Native actor capacity was not reserved")
                   slot.bound(child.id, acceptedSnapshot)
                   projected = true
                   if (!owner) await set("owner/" + ref.missionID + "/" + ref.taskKey, binding)
                  await set("binding/" + tool.sessionID + "/" + tool.id, binding)
                  await set("current/" + child.id, binding)
                }
                const progressKey = "progress/" + tool.sessionID + "/" + tool.id
                const progress = await get<unknown[]>(progressKey) ?? []
                if (progress.length >= 200) throw new Error("Bounded native progress exceeded")
                await set(progressKey, [...progress, update])
              })
              await tool.progress(update)
             } }) } catch (error) {
               if (binding && projected) {
                 const endedBinding = binding
                 await exclusive(() => event(ref.missionID, "error-" + tool.sessionID + "-" + tool.id, { type: "task.native-call-ended", taskKey: ref.taskKey, childSessionID: endedBinding.childID, binding: nativeBinding(endedBinding), outcome: "error" }))
               }
               throw error
             }
            assertActive()
            if (!binding) throw new Error("Native tool returned without structured child binding")
            const report = await get<{ id: string }>("report/" + ref.missionID + "/" + ref.taskKey)
            const receipt = { contract: ref, ...binding, reportID: report?.id ?? null, nativeMetadata: result.metadata ?? {}, nativeReturned: true }
            await set("returned/" + tool.sessionID + "/" + tool.id, receipt)
             const returnedBinding = binding
             await exclusive(() => event(ref.missionID, "returned-" + tool.sessionID + "-" + tool.id, firstBinding
               ? { type: "task.native-returned", taskKey: ref.taskKey, binding: nativeBinding(returnedBinding), childSessionID: returnedBinding.childID }
               : { type: "task.native-call-ended", taskKey: ref.taskKey, binding: nativeBinding(returnedBinding), childSessionID: returnedBinding.childID, outcome: "returned" }))
            // Native result remains the return path; no synthetic/outbox message is added.
            const reference = report ? "MISSION_BUSINESS_REPORT_REFERENCE:" + JSON.stringify({ contract: ref, reportID: report.id }) : undefined
            const content = !reference ? result.content : typeof result.content === "string" ? result.content + "\n" + reference : [...(result.content ?? []), { type: "text" as const, text: reference }]
            return { ...result, content, metadata: { ...result.metadata, missionContract: receipt } }
           } finally { slot?.release(); prepared.release() }
         }) } finally { if (taskFlights.get(flightKey) === flight) taskFlights.delete(flightKey) }
      }
      const extended = definition.input as unknown as Schema.Struct<Schema.Struct.Fields>
      nativeFieldsPreserved = original.every(([field, value]) => definition[field as keyof typeof definition] === value)
        && Object.entries(input.fields).every(([field, value]) => extended.fields[field] === value)
      if (!nativeFieldsPreserved) throw new Error("Native fields or input field schemas changed beyond contract envelope")
    })
  }))
  return {
    seed: (raw: unknown) => exclusive(() => contractPlans.seed(raw)),
    revise: (raw: unknown) => exclusive(() => contractPlans.revise(raw)),
    inspect: async () => ({ nativeFieldsPreserved, snapshot: await journal.snapshot(), entries: (await ctx.storage.scan({ prefix, limit: 1000 })).entries }),
    dispose: async () => { active = false; await Promise.allSettled(registrations.map(r => r.dispose())) },
  }
}
