import { isDeepStrictEqual } from "node:util"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Rpc, type Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import { z } from "zod"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionBusinessCall, missionBusinessMethods, missionBusinessResult, type MissionBusinessControl, type MissionBusinessMethod } from "../../missions/business-control"
import { parseMissionDocument } from "../../missions/mission-document"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import type { NativeDocumentBusiness } from "./desktop-plugin"
import type { nativeInvocation } from "./native-invocation"
import { assertNativeScheduleCarrierArtifacts, nativeScheduleDocumentKey, type NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS, NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES } from "./native-schedule-transport"
import { assertNativeScheduleIncarnation, nativeScheduleIncarnationGuard, readNativeScheduleIncarnation, type NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { acquireNativeScheduledPassageRuntime, isNativeScheduledPassageFamily, type NativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"

type Invocation = ReturnType<typeof nativeInvocation>
type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
type Entry = { current(): true; signal: AbortSignal }
type Runtime = Pick<NativeScheduledPassageRuntime, "businessSelection" | "executeBusiness" | "prepareBusiness" | "reconcile">
type Acquire = (run: Run) => Effect.Effect<Runtime, unknown, import("effect").Scope.Scope>
const id = z.string().min(1).max(240)
const bindingSchema = z.object({ documentID: id, passageID: id, missionID: id, rootID: id }).strict()
type Binding = z.infer<typeof bindingSchema>
type Source = { binding: Binding; installation: NativeScheduleCarrierInstallation; requiresCalendar: boolean }
const sameSource = (left: Source | undefined, right: Source | undefined) => isDeepStrictEqual(left?.binding, right?.binding)
  && isDeepStrictEqual(left?.installation, right?.installation) && left?.requiresCalendar === right?.requiresCalendar
const baseSchema = z.object({ sessionID: id.regex(/^ses_/), binding: bindingSchema, incarnation: z.unknown() }).strict()
const executeSchema = baseSchema.extend({ method: z.enum(missionBusinessMethods), args: z.array(z.unknown()).max(4) }).strict()
const replySchema = z.object({ selected: z.boolean(), readSessionID: id.optional(), value: z.unknown().optional() }).strict()
const text = { type: "string", minLength: 1, maxLength: 4096 } as const
const base = { type: "object", properties: { sessionID: text,
  binding: { type: "object", properties: { documentID: text, passageID: text, missionID: text, rootID: text },
    required: ["documentID", "passageID", "missionID", "rootID"], additionalProperties: false },
  incarnation: { type: "object", properties: { id: text, pid: { type: "integer", minimum: 1 }, url: text, version: text },
    required: ["id", "pid", "url"], additionalProperties: false } }, required: ["sessionID", "binding", "incarnation"], additionalProperties: false } as const
const output = { type: "object", properties: { selected: { type: "boolean" }, readSessionID: text, value: {} }, required: ["selected"], additionalProperties: false } as const
export const NativeScheduledBusinessRpc = { id: "codenomad.missions.business/v1", methods: {
  select: { input: base, output }, prepare: { input: base, output }, execute: { input: { ...base,
    properties: { ...base.properties, method: { enum: missionBusinessMethods }, args: { type: "array", maxItems: 4, items: {} } },
    required: [...base.required, "method", "args"] }, output },
}, events: {} } as const

/** Optional fields follow the native JSON wire; executable/nonfinite values never cross it. */
function json(value: unknown, request = true): unknown {
  const encoded = JSON.stringify(value, (_key, entry) => {
    if (["function", "symbol", "bigint"].includes(typeof entry) || typeof entry === "number" && !Number.isFinite(entry)) throw new Error("Invalid business JSON")
    return entry
  })
  if (encoded === undefined) throw new Error("Missing business JSON")
  if (Buffer.byteLength(encoded) > NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES) throw new Error("Business JSON too large")
  const parsed: unknown = JSON.parse(encoded)
  // Replies include fitted inspection values, whose valid artifact nesting can
  // exceed an authority request's depth once placed inside the RPC envelope.
  if (request) canonicalAuthority(parsed, NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES)
  return parsed
}

/** Public facade and exact KV only. Ordinary/daily sources do not discover or RPC. */
async function source(ctx: Plugin.Context, sessionID: string, run: Run, current: () => true) {
  let root: Effect.Success<ReturnType<typeof ctx.session.get>> | undefined
  const owned = await isNativeScheduledPassageFamily(sessionID, async value => {
    current()
    const session = await run(Effect.suspend(() => { current(); return ctx.session.get({ sessionID: Session.ID.make(value) }) }))
    current()
    if (session.projectID !== ctx.location.project.id || session.location.directory !== ctx.location.directory
      || session.location.workspaceID !== ctx.location.workspaceID) throw new Error("Business source moved")
    if (!session.parentID) root = session
    return session
  })
  if (!owned || !root) return undefined
  const marker = root.metadata?.["codenomad.mission"] as { missionID?: unknown; document?: { missionID?: unknown; passageID?: unknown } } | undefined
  if (typeof marker?.document?.missionID !== "string") throw new Error("Business document marker unavailable")
  const doc = parseMissionDocument(await run(ctx.storage.get(nativeScheduleDocumentKey(ctx, marker.document.missionID))), {
    id: marker.document.missionID, projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
  })
  current()
  if (!doc.pending || doc.pending.id !== marker.document.passageID || doc.pending.missionID !== marker.missionID) return undefined
  if (!doc.calendarOwner || !doc.pending.configuration.roots.some(root => root.directory === ctx.location.directory)) throw new Error("Business installation unavailable")
  return { binding: { documentID: doc.id, passageID: doc.pending.id, missionID: doc.pending.missionID, rootID: root.id },
    installation: doc.calendarOwner.installation, requiresCalendar: requiresMissionCalendar(doc.pending.configuration.launch) }
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  let length = 0
  try {
    if (Number(response.headers.get("content-length")) > NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES) throw new Error("Business response too large")
    while (reader) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES) throw new Error("Business response too large")
      chunks.push(next.value)
    }
    signal.throwIfAborted()
    const headers = new Headers(response.headers)
    headers.delete("content-length"); headers.delete("content-encoding")
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers })
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader?.releaseLock() }
}

/** No private Core graph or native RPC handle is retained by this client port. */
export function createNativeScheduledBusinessBridge(ctx: Plugin.Context, invocation: Invocation, current: () => true = () => true): NativeDocumentBusiness {
  const call = (sessionID: string, method: keyof typeof NativeScheduledBusinessRpc.methods,
    args?: { method: MissionBusinessMethod; args: unknown[] }, captured?: Source): Promise<{ reply: z.infer<typeof replySchema>; source: Source | undefined }> => invocation.check(async run => {
    const controller = new AbortController(), deadline = performance.now() + NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS)
    const signal = controller.signal
    const live = (): true => { if (performance.now() >= deadline) controller.abort(); signal.throwIfAborted(); return current() }
    const boundedRun: Run = effect => run(effect.pipe(Effect.timeout(Math.max(0, deadline - performance.now()))))
    try {
      const found = await source(ctx, sessionID, boundedRun, live)
      if (!found) return { reply: { selected: false }, source: undefined }
      if (captured && !sameSource(found, captured)) throw new Error("Business source changed")
      const incarnation = readNativeScheduleIncarnation(found.installation.registrationFile)
      const guard = nativeScheduleIncarnationGuard(found.installation.registrationFile, incarnation)
      live(); guard()
      const endpoint = await boundedRun(Effect.tryPromise(() => Service.discover({ file: found.installation.registrationFile })))
      live(); guard()
      if (!endpoint || endpoint.url !== incarnation.url) throw new Error("Business discovery unavailable")
      const checked = await source(ctx, sessionID, boundedRun, live)
      if (!sameSource(found, checked)) throw new Error("Business source changed")
      const payload = json({ sessionID, binding: found.binding, incarnation, ...args })
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url)
        const expected = new URL(`/api/rpc/${encodeURIComponent(NativeScheduledBusinessRpc.id)}/${method}`, endpoint.url)
        live(); guard()
        if (url.origin !== expected.origin || url.pathname !== expected.pathname || request.method !== "POST") throw new Error("Business RPC target differs")
        return boundedResponse(await globalThis.fetch(request, { signal, redirect: "error" }), signal)
      } })
      const rawReply = await client.rpc(NativeScheduledBusinessRpc)[method](payload as never, { location: { directory: ctx.location.directory }, signal })
      live(); guard()
      const reply = replySchema.parse(json(rawReply, false))
      if (!reply || typeof reply.selected !== "boolean" || reply.selected && method === "select" && reply.readSessionID !== found.binding.rootID)
        throw new Error("Business RPC reply unavailable")
      return { reply, source: { binding: found.binding, installation: found.installation, requiresCalendar: found.requiresCalendar } }
    } catch { throw new Error("Scheduled Mission business unavailable") }
    finally { clearTimeout(timer); controller.abort() }
  })
  return {
    select: async sessionID => {
      const selected = await call(sessionID, "select")
      if (!selected.reply.selected || !selected.source) return undefined
      const captured = selected.source
      const control = Object.fromEntries(missionBusinessMethods.map(method => [method, (...args: unknown[]) => {
        if (method === "interruptTask" || method === "prepare") return Promise.reject(new Error("Scheduled Mission backend actions unavailable"))
        return call(sessionID, "execute", { method, args }, captured).then(result => {
          if (!result.reply.selected) throw new Error("Scheduled business selection changed")
          return result.reply.value
        })
      }])) as unknown as MissionBusinessControl
      Object.defineProperty(control, "backendActions", { value: false, enumerable: true })
      return { control, readSessionID: captured.binding.rootID, current,
        beforeTool: async () => { current() }, execute: use => { current(); return use(control) } }
    },
    // Prompt hooks can run inside B's document exclusion while native admission
    // awaits their return. Only acknowledge exact public membership here.
    prepare: sessionID => invocation.check(async run => Boolean(await source(ctx, sessionID, run, current))),
  }
}

/** Validated dispatcher kept separate from registration for narrow graph tests. */
export async function executeNativeScheduledBusiness(runtime: Runtime, entry: Entry, input: z.infer<typeof executeSchema>, binding: Binding,
  targetBinding?: (sessionID: string) => Promise<Binding | undefined>) {
  const selected = await runtime.businessSelection(input.sessionID, entry)
  if (!selected) return { selected: false }
  if (selected.readSessionID !== binding.rootID) throw new Error("Business root changed")
  const call = missionBusinessCall(input.method, input.args, input.sessionID, selected.readSessionID, binding.missionID)
  if ("targetSessionID" in call && call.targetSessionID) {
    const owned = await targetBinding?.(call.targetSessionID)
    if (!owned || owned.documentID !== binding.documentID || owned.passageID !== binding.passageID || owned.missionID !== binding.missionID)
      throw new Error("Foreign business target")
    const target = await runtime.businessSelection(call.targetSessionID, entry)
    if (!target || target.readSessionID !== call.targetSessionID) throw new Error("Foreign business target")
  }
  const result = await runtime.executeBusiness(input.sessionID, entry, async control =>
    missionBusinessResult(input.method, input.args, await call.invoke(control)), call.tool)
  entry.current()
  return result ? json({ selected: true, value: result.value }, false) : { selected: false }
}

/** Only this HTTP receiver acquires B's full native runtime. The optional
 * acquirer is a typed test seam; no RPC input can select code or capabilities. */
export const registerNativeScheduledBusinessRpc = Effect.fn("missions.registerScheduledBusinessRpc")(function* (
  ctx: Plugin.Context, artifacts: NativeScheduleArtifacts | undefined, invocation: Invocation,
  acquire: Acquire = run => acquireNativeScheduledPassageRuntime(ctx, run),
) {
  let active = true
  const current = (): true => { if (!active) throw new Error("Scheduled business registration retired"); return true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const handler = (method: keyof typeof NativeScheduledBusinessRpc.methods) => (raw: unknown) => invocation.capture(Effect.scoped(Effect.gen(function* () {
    const signal = yield* Effect.abortSignal
    const input = (method === "execute" ? executeSchema : baseSchema).parse(json(raw))
    assertNativeScheduleIncarnation(input.incarnation)
    return yield* Effect.tryPromise({ try: () => invocation.check(async run => {
      const found = await source(ctx, input.sessionID, run, current)
      if (!found) return { selected: false }
      if (!isDeepStrictEqual(found.binding, input.binding))
        throw new Error("Business receiver binding differs")
      if (found.requiresCalendar) {
        if (artifacts && !isDeepStrictEqual(found.installation.provider, artifacts.provider)) throw new Error("Business receiver provider differs")
        assertNativeScheduleCarrierArtifacts(found.installation)
      }
      const incarnation = nativeScheduleIncarnationGuard(found.installation.registrationFile, input.incarnation as NativeScheduleIncarnation)
      const live = (): true => { signal.throwIfAborted(); current(); return incarnation() }
      live()
      return run(Effect.scoped(Effect.gen(function* () {
        // B consumes current inside its SQL publication fences too: keep this
        // synchronous invocation/incarnation-only, never a nested database read.
        const entry = { current: live, signal }
        const runtime = yield* acquire(run)
        const result = yield* Effect.tryPromise({ try: async () => {
          if (method === "execute") return executeNativeScheduledBusiness(runtime, entry, executeSchema.parse(input), found.binding,
            async id => (await source(ctx, id, run, entry.current))?.binding)
          // A resumed original turn can reach context before its lost admission
          // ACK was published to the document. B alone reconciles that identity;
          // its attempted-input guard keeps missing originals uncertain.
          await runtime.reconcile({ missionID: found.binding.documentID, ...entry })
          const reconciled = await source(ctx, input.sessionID, run, live)
          if (!reconciled) return { selected: false }
          if (!sameSource(found, reconciled)) throw new Error("Business pending changed during reconciliation")
          const prepared = await runtime.prepareBusiness(input.sessionID, entry)
          if (method === "prepare") return { selected: true, value: prepared }
          if (!prepared) return { selected: false }
          const selected = await runtime.businessSelection(input.sessionID, entry)
          if (selected && selected.readSessionID !== found.binding.rootID) throw new Error("Business root changed")
          return selected ? { selected: true, readSessionID: selected.readSessionID } : { selected: false }
        }, catch: () => new Error("Scheduled business execution unavailable") })
        live()
        return json(result, false)
      })))
    }), catch: () => new Error("Scheduled business receiver unavailable") })
  }))).pipe(Effect.timeout("8 seconds"), Effect.orDie)
  yield* ctx.rpc.register(Rpc.define(NativeScheduledBusinessRpc), { select: handler("select"), prepare: handler("prepare"), execute: handler("execute") })
  return createNativeScheduledBusinessBridge(ctx, invocation, current)
})
