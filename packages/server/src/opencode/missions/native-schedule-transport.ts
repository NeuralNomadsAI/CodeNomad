import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation, sameNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { assertNativeScheduleWake, NativeScheduleTransportRpc, nativeScheduleWakeIdentity, nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import type { NativeScheduleTransportReply, NativeScheduleWake, NativeSchedulePreflight } from "./native-schedule-transport-contract"

export const NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS = 8_000
export const NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES = 1024 * 1024
type FailureReason = "busy" | "held" | "deadline" | "unavailable"
export type NativeScheduleTransportResult =
  | { state: "received"; reply: NativeScheduleTransportReply }
  | { state: "not-dispatched" | "uncertain"; reason: FailureReason }

type Request = {
  registrationFile: string
  directory: string
  wake: NativeScheduleWake
  signal?: AbortSignal
  preflight?: NativeSchedulePreflight
}
type Mutation = Request & {
  /** Durable CAS, under the same Mission exclusion as controls: persist the exact
   * dispatch intent before true. Any unresolved dispatch in this Mission, or any
   * prior dispatch of this exact identity, must return false.
   * Release the business exclusion before returning; RPC acquires it separately. */
  claim: (incarnation: NativeScheduleIncarnation) => Promise<boolean>
}
type Dependencies = { discover: typeof Service.discover; headers: typeof Service.headers; fetch: typeof fetch }

// Bundled plugin incarnations share one lane, including late read-only discoveries.
const laneSymbol = Symbol.for("codenomad.missions.native-schedule-transport.lanes")
const host = globalThis as typeof globalThis & { [laneSymbol]?: Set<string> }
const lanes = host[laneSymbol] ??= new Set<string>()

export async function boundedNativeScheduleResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (Number(response.headers.get("content-length")) > NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES) throw new Error("schedule-response-size")
    let size = 0
    while (reader) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES) throw new Error("schedule-response-size")
      chunks.push(value)
    }
    signal.throwIfAborted()
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers })
  } catch (error) { cancel(); throw error }
  finally { signal.removeEventListener("abort", cancel); reader?.releaseLock() }
}

/** In-process official discovery + HTTP RPC only. The caller owns durable intents,
 * mapping/Location authorization and status reconciliation across plugin reloads. */
export function createNativeScheduleTransport(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { discover: Service.discover, headers: Service.headers, fetch: globalThis.fetch, ...overrides }
  const invoke = async (mode: "wake" | "status", request: Request, claim?: Mutation["claim"]): Promise<NativeScheduleTransportResult> => {
    // Snapshot mutable caller inputs before the first await.
    const { registrationFile, directory } = request, wake = nativeScheduleWakeIdentity({ ...request.wake })
    const preflight = request.preflight && { ...request.preflight }
    let dispatched = false
    const failure = (reason: FailureReason): NativeScheduleTransportResult => ({ state: dispatched ? "uncertain" : "not-dispatched", reason })
    try {
      assertNativeScheduleWake(wake)
      if (!path.isAbsolute(registrationFile) || !path.isAbsolute(directory)) throw new Error("schedule-path")
    } catch { return failure("unavailable") }
    const lane = wake.missionID
    if (lanes.has(lane)) return failure("busy")
    lanes.add(lane)
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    const deadline = performance.now() + NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS)
    const check = () => {
      if (performance.now() >= deadline) controller.abort()
      signal.throwIfAborted()
    }
    const discover = async () => {
      check()
      const identity = readNativeScheduleIncarnation(registrationFile)
      nativeScheduleIncarnationGuard(registrationFile, identity)()
      check()
      // No default file, version allowlist, lifecycle operation or child process.
      const endpoint = await deps.discover({ file: registrationFile })
      check() // discover has no AbortSignal; a late probe must never send a POST.
      nativeScheduleIncarnationGuard(registrationFile, identity)()
      check()
      if (!endpoint || endpoint.url !== identity.url) throw new Error("schedule-discovery")
      return { identity, endpoint }
    }
    let onAbort: () => void = () => {}
    const aborted = new Promise<NativeScheduleTransportResult>(resolve => {
      onAbort = () => resolve(failure("deadline"))
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const operation = (async (): Promise<NativeScheduleTransportResult> => {
      try {
        const captured = await discover()
        const checked = await discover()
        if (!sameNativeScheduleIncarnation(captured.identity, checked.identity)) throw new Error("schedule-incarnation-changed")
        const guard = nativeScheduleIncarnationGuard(registrationFile, checked.identity)
        const client = OpenCode.make({ baseUrl: checked.endpoint.url, headers: deps.headers(checked.endpoint),
          fetch: async (input, init) => {
            check(); guard(); check()
            const url = new URL(input instanceof globalThis.Request ? input.url : String(input))
            const expected = new URL(`/api/rpc/${NativeScheduleTransportRpc.id}/${mode}`, checked.endpoint.url)
            if (url.origin !== expected.origin || url.pathname !== expected.pathname || init?.method !== "POST")
              throw new Error("schedule-rpc-target")
            // A request can continue remotely after cancellation; receiver must fence
            // incarnation and durable Mission state again before every effect.
            dispatched = true
            return boundedNativeScheduleResponse(await deps.fetch(input, { ...init, signal, redirect: "error" }), signal)
          } })
        check(); guard(); check()
        if (mode === "wake" && (!claim || !await claim(checked.identity))) return failure("held")
        check(); guard(); check()
        const raw = await client.rpc(NativeScheduleTransportRpc)[mode]({ wake, incarnation: checked.identity, registrationFile, ...(preflight ? { preflight } : {}) },
          { location: { directory }, signal })
        check(); guard(); check()
        const reply = raw as NativeScheduleTransportReply
        if (!reply || reply.key !== nativeScheduleWakeKey(wake)
          || !["applied", "pending", "rejected", "unknown"].includes(reply.state)
          || reply.messagePresent !== undefined && typeof reply.messagePresent !== "boolean"
          || reply.ready !== undefined && typeof reply.ready !== "boolean"
          || reply.preflight !== undefined && (!Number.isSafeInteger(reply.preflight.cutoff) || reply.preflight.cutoff < 0
            || !Number.isSafeInteger(reply.preflight.issuedAt) || reply.preflight.issuedAt < 0
            || !/^[a-f0-9]{64}$/.test(reply.preflight.signature))) throw new Error("schedule-rpc-reply")
        return { state: "received", reply: { key: reply.key, state: reply.state,
          ...(reply.messagePresent === undefined ? {} : { messagePresent: reply.messagePresent }),
          ...(reply.ready === undefined ? {} : { ready: reply.ready }), ...(reply.preflight ? { preflight: { ...reply.preflight } } : {}) } }
      } catch { return failure(signal.aborted ? "deadline" : "unavailable") }
    })()
    // A timed-out discovery remains a read, and keeps its lane until it actually ends.
    void operation.finally(() => lanes.delete(lane))
    try { return await Promise.race([operation, aborted]) }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort) }
  }
  return { wake: (request: Mutation) => invoke("wake", request, request.claim), status: (request: Request) => invoke("status", request) }
}
