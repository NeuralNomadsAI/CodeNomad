import type { Plugin } from "@opencode/plugin"
import type * as Tool from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import { taskContractReferenceSchema, type TaskContractReference } from "../../missions/task-declaration"
import { nativeCallBindingSchema, taskContractReferenceWireSchema } from "../../missions/native-wire-schema"

/** Experimental capability seam only. Installing this is NOT host qualification.
 * No desktop/plugin entrypoint imports it. The authenticated, owner-derived host
 * must implement these admissions with real signed authority/shared-journal
 * agreement and durable capacity, not a JS assertion or envelope attestation.
 */
export type NativeTaskReference = Readonly<TaskContractReference>

export interface NativeTaskInvocation extends Pick<Tool.ToolContext, "sessionID" | "messageID" | "id" | "agent"> {
  /** Actual native input, with only the optional mission extension removed. */
  readonly nativeInput: Readonly<Record<string, unknown>>
  readonly mission?: NativeTaskReference
}

export interface NativeTaskFence {
  readonly signal: AbortSignal
  /** Synchronous revocation/ownership fence; host operations must repeat it
   * after awaits and immediately before protected mutations/ENV writes. */
  assertCurrent(): void
}

export type NativeTaskReservation<Claim extends object> = {
  readonly scope: "owned" | "unowned"
  /** Opaque host capability, never included in tool input/output. */
  readonly claim: Claim
}

type Phase = "reserve" | "continuation" | "native" | "bind" | "progress" | "launch-return" | "return" | "report-reference"

export interface NativeTaskFailure<Claim extends object, Bound extends object> {
  readonly invocation: NativeTaskInvocation
  readonly reservation?: NativeTaskReservation<Claim>
  readonly bound?: Bound
  readonly observedChildSessionID?: string
  readonly phase: Phase
  readonly error: unknown
  readonly nativeResult?: Tool.Result
  readonly retired: boolean
}

export interface NativeTaskAdmissions<Claim extends object, Bound extends object> {
  /** Throw on unknown/revoked ownership, connection, lifecycle or policy.
   * This returns void, NOT an unsigned `true` attestation. */
  assertCurrent(invocation: NativeTaskInvocation, reservation?: NativeTaskReservation<Claim>): void
  /** Mandatory for EVERY call, including calls without mission. Reserve the
   * exact native session/message/call and requested input before native birth.
   * Owned declared calls require durable task/capacity authority; owned raw
   * descendants require family/lifecycle/ENV admission, not task authority.
   * Only a positive trusted policy decision may return scope: "unowned". */
  reserve(invocation: NativeTaskInvocation, fence: NativeTaskFence): Promise<NativeTaskReservation<Claim>>
  /** Before native execution when input.sessionID exists: verify the exact
   * previous execution has ended/returned and is idle, explicit reuseFromTaskKey,
   * actual bound child, ownership and native continuation identity. */
  guardContinuation(invocation: NativeTaskInvocation, reservation: NativeTaskReservation<Claim>, childSessionID: string,
    fence: NativeTaskFence): Promise<void>
  /** Called once, only from awaited structured native progress.sessionID.
   * Establish signed binding + shared-journal agreement, then freshly prepare
   * the owned child's ENV before resolving. Never create/prompt a child here.
   * Even unowned calls go through this callback; only trusted policy may exempt
   * them from owned-family ENV. A returned object is a handle, NOT proof. */
  bindActualChild(invocation: NativeTaskInvocation, reservation: NativeTaskReservation<Claim>, childSessionID: string,
    fence: NativeTaskFence): Promise<Bound>
  /** Background launch return is NOT execution end or business completion. */
  launchReturned(invocation: NativeTaskInvocation, reservation: NativeTaskReservation<Claim>, bound: Bound,
    result: Tool.Result, fence: NativeTaskFence): Promise<void>
  /** Actual foreground tool return is NOT business completion. */
  returned(invocation: NativeTaskInvocation, reservation: NativeTaskReservation<Claim>, bound: Bound,
    result: Tool.Result, fence: NativeTaskFence): Promise<void>
  /** Observation only, including partial binding/retirement. Never release a
   * durable claim on ambiguity, replay a send, or infer native rollback. Failure
   * of this observation must not replace the original native/admission error. */
  failureObserved(failure: NativeTaskFailure<Claim, Bound>): Promise<void>
  reportReference?(bound: Bound, fence: NativeTaskFence): Promise<(NativeTaskReference & { readonly reportID?: string }) | undefined>
}

const nativeIDWireSchema = nativeCallBindingSchema.properties.parentSessionID
// RPC wire schemas use the native decoder's regex-free subset. Runtime
// identity validation must remain strict independently of that projection.
const nativeIDPattern = /^[^\s\x00-\x1f\x7f]+$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= nativeIDWireSchema.minLength
    && value.length <= nativeIDWireSchema.maxLength && nativeIDPattern.test(value)
}

function snapshotInput(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const snapshot = structuredClone(input)
  const seen = new Set<object>()
  const pending: object[] = [snapshot]
  while (pending.length) {
    const value = pending.pop()!
    if (seen.has(value)) continue
    seen.add(value)
    Object.values(value).forEach(child => {
      if (child !== null && typeof child === "object") pending.push(child)
    })
    Object.freeze(value)
  }
  return snapshot
}

function reference(value: unknown, report = false): NativeTaskReference & { readonly reportID?: string } {
  if (!record(value)) throw new Error("Invalid strict native task reference")
  const { reportID, ...taskReference } = value
  if ("reportID" in value && (!report || !identifier(reportID))) throw new Error("Invalid strict native task reference")
  const parsed = taskContractReferenceSchema.safeParse(report ? taskReference : value)
  if (!parsed.success) throw new Error("Invalid strict native task reference")
  return Object.freeze({ ...parsed.data, ...(report && "reportID" in value ? { reportID: reportID as string } : {}) })
}

function extendInput(input: Tool.Info["input"]): Tool.Info["input"] {
  // This bounded experiment supports native object JSON schemas. Do not guess
  // how to rewrite arbitrary codecs/StandardSchema, composition or a collision.
  if (!record(input) || input.type !== "object" || !record(input.properties)
    || "mission" in input.properties || "allOf" in input || "anyOf" in input || "oneOf" in input
    || "$ref" in input || "~standard" in input) {
    throw new Error("Unsupported native subagent input schema")
  }
  return { ...input, properties: { ...input.properties, mission: taskContractReferenceWireSchema } }
}

function appendReference(result: Tool.Result, value: NativeTaskReference & { readonly reportID?: string }): Tool.Result {
  const text = JSON.stringify({ mission: value })
  return { ...result, content: typeof result.content === "string"
    ? `${result.content}\n\n${text}` : [...(result.content ?? []), { type: "text", text }] }
}

/** Official ToolEditor update: only input's optional mission property and execute
 * change. Options, native permission/depth/agent/model/confirmation logic, output
 * schema, descriptions and every other definition field remain native-owned.
 * Direct and Code Mode snapshots capture this same executor and original signal.
 */
export async function installNativeTaskAdapter<Claim extends object, Bound extends object>(
  ctx: Pick<Plugin.Context, "tool">,
  admissions: NativeTaskAdmissions<Claim, Bound>,
): Promise<Registration> {
  for (const name of ["assertCurrent", "reserve", "guardContinuation", "bindActualChild", "launchReturned", "returned", "failureObserved"] as const) {
    if (typeof admissions?.[name] !== "function") throw new Error(`Missing trusted native task admission: ${name}`)
  }
  let active = true
  // Only an immediate overlapping invocation veto. NOT a durable capacity claim;
  // background execution and later/replayed calls remain the host's responsibility.
  const calls = new Set<string>()
  const tasks = new Set<string>()
  const children = new Set<string>()
  let registration: Registration
  try {
    registration = await ctx.tool.transform((editor: Tool.ToolEditor) => {
      const source = editor.get("subagent")
      if (!source) throw new Error("Native subagent tool unavailable")
      // Validate outside update: native editors may log/ignore invalid updates.
      const inputSchema = extendInput(source.input)
      editor.update("subagent", draft => {
        const native = draft.execute
        draft.input = inputSchema
        draft.execute = async (input: unknown, tool: Tool.ToolContext): Promise<Tool.Result> => {
          if (!record(input)) throw new Error("Invalid native subagent input")
          const mission = "mission" in input ? reference(input.mission) : undefined
          if (![tool.sessionID, tool.messageID, tool.id].every(identifier)) throw new Error("Invalid actual native invocation identity")
          const { mission: _mission, ...requestedInput } = input
          // Code Mode callers may retain their input across the admission await.
          // The host and native executor must see the exact same requested data,
          // not caller edits made after reservation. Native keeps a writable copy.
          const nativeInput = structuredClone(requestedInput)
          if ("sessionID" in nativeInput && !identifier(nativeInput.sessionID)) throw new Error("Invalid native continuation sessionID")
          const invocation: NativeTaskInvocation = Object.freeze({ sessionID: tool.sessionID, messageID: tool.messageID,
            id: tool.id, agent: tool.agent, nativeInput: snapshotInput(nativeInput), ...(mission ? { mission } : {}) })
          let reservation: NativeTaskReservation<Claim> | undefined
          let invocationActive = true
          const assertCurrent = () => {
            if (!active) throw new Error("Native task adapter retired")
            if (!invocationActive) throw new Error("Native task invocation retired")
            tool.signal.throwIfAborted()
            if (admissions.assertCurrent(invocation, reservation) !== undefined) throw new Error("Invalid synchronous native task fence")
          }
          const fence: NativeTaskFence = { signal: tool.signal, assertCurrent }
          assertCurrent()
          const callKey = JSON.stringify([tool.sessionID, tool.messageID, tool.id])
          const taskKey = mission ? JSON.stringify([mission.missionID, mission.taskKey]) : undefined
          const heldChildren = new Set<string>()
          const continuation = nativeInput.sessionID as string | undefined
          if (calls.has(callKey) || (taskKey && tasks.has(taskKey)) || (continuation && children.has(continuation))) {
            throw new Error("Overlapping native task invocation")
          }
          calls.add(callKey)
          if (taskKey) tasks.add(taskKey)
          const holdChild = (child: string) => {
            if (heldChildren.has(child)) return
            if (children.has(child)) throw new Error("Overlapping native child invocation")
            children.add(child); heldChildren.add(child)
          }
          if (continuation) holdChild(continuation)
          let bound: Bound | undefined
          let observedChildSessionID: string | undefined
          let nativeResult: Tool.Result | undefined
          let phase: Phase = "reserve"
          let progressBusy = false
          let nativeSettled = false
          let progressError: unknown
          let progressFailed = false
          const observeFailure = async (error: unknown) => {
            try { await admissions.failureObserved({ invocation, reservation, bound, observedChildSessionID,
              phase, error, nativeResult, retired: !active || !invocationActive }) } catch { /* Preserve original error and honest ambiguity. */ }
          }
          try {
            reservation = await admissions.reserve(invocation, fence)
            assertCurrent()
            if (!record(reservation) || !["owned", "unowned"].includes(reservation.scope) || !record(reservation.claim)
              || (mission && reservation.scope !== "owned")) throw new Error("Unknown native task admission")
            if (continuation) {
              phase = "continuation"
              await admissions.guardContinuation(invocation, reservation, continuation, fence)
              assertCurrent()
            }
            phase = "native"
            nativeResult = await native(nativeInput, { ...tool, progress: async update => {
              let ownsProgress = false
              try {
                assertCurrent()
                if (progressFailed) throw progressError
                if (nativeSettled || progressBusy) throw new Error("Unsettled native child progress")
                progressBusy = true; ownsProgress = true
                if (!record(update)) throw new Error("Invalid native child progress metadata")
                if ("sessionID" in update) {
                  if (!identifier(update.sessionID)) throw new Error("Invalid structured native child sessionID")
                  if ((observedChildSessionID && observedChildSessionID !== update.sessionID)
                    || (continuation && continuation !== update.sessionID)) throw new Error("Native child identity changed")
                  observedChildSessionID = update.sessionID
                  holdChild(update.sessionID)
                  if (!bound) {
                    phase = "bind"
                    const bindingFence: NativeTaskFence = { signal: tool.signal, assertCurrent: () => {
                      assertCurrent()
                      if (nativeSettled || progressFailed) throw progressError ?? new Error("Native child progress outlived execution")
                    } }
                    bound = await admissions.bindActualChild(invocation, reservation!, update.sessionID, bindingFence)
                    assertCurrent()
                    if (nativeSettled || progressFailed) throw progressError ?? new Error("Native child progress outlived execution")
                    if (!record(bound)) throw new Error("Unknown actual child binding")
                  }
                }
                phase = "progress"
                await tool.progress(update)
                assertCurrent()
                phase = "native"
              } catch (error) {
                if (!progressFailed) progressError = error
                progressFailed = true
                // A native executor that failed to await progress can settle
                // before a partial host binding becomes observable. Retain the
                // later evidence too; never turn it into release/replay.
                if (nativeSettled) await observeFailure(error)
                throw error
              } finally { if (ownsProgress) progressBusy = false }
            } })
            nativeSettled = true
            assertCurrent()
            if (progressFailed) throw progressError
            if (progressBusy || !bound) throw new Error("Native tool returned without settled actual child binding")
            if (nativeResult.metadata?.sessionID !== undefined && nativeResult.metadata.sessionID !== observedChildSessionID) {
              throw new Error("Native result child identity changed")
            }
            if (nativeResult.metadata?.status === "running") {
              phase = "launch-return"
              await admissions.launchReturned(invocation, reservation, bound, nativeResult, fence)
            } else {
              phase = "return"
              await admissions.returned(invocation, reservation, bound, nativeResult, fence)
            }
            assertCurrent()
            if (!admissions.reportReference) return nativeResult
            phase = "report-reference"
            const supplied = await admissions.reportReference(bound, fence)
            assertCurrent()
            if (supplied === undefined) return nativeResult
            const ref = reference(supplied, true)
            if (mission && (ref.missionID !== mission.missionID || ref.taskKey !== mission.taskKey || ref.generation !== mission.generation)) {
              throw new Error("Native report reference differs from declared task")
            }
            return appendReference(nativeResult, ref)
          } catch (error) {
            nativeSettled = true
            await observeFailure(error)
            throw error
          } finally {
            // Never release any durable claim. Host settlement owns that decision.
            invocationActive = false
            calls.delete(callKey)
            if (taskKey) tasks.delete(taskKey)
            heldChildren.forEach(child => children.delete(child))
          }
        }
      })
    })
  } catch (error) { active = false; throw error }
  return { dispose: async () => {
    // Captured executable snapshots survive native registration disposal.
    // Retire the closure FIRST, including callbacks already awaiting admission.
    active = false
    await registration.dispose()
  } }
}
