import type { IntegrationStatus } from "./contract"
import { readIntegrationRpcOutput } from "./contract"
import type { IntegrationRecognition } from "./recognition"

/** Bound on one integration's `status` call; past it that integration is `unknown`, the others still answer. */
export const INTEGRATION_STATUS_TIMEOUT_MS = 8_000
/** RPC calls one integrations read keeps in flight. */
export const INTEGRATION_STATUS_CONCURRENCY = 4

/**
 * `absent`: not configured; `inactive`: configured but not loaded (disabled, or not installed yet); `failed`: the
 * runtime failed to load it; `unsupported`: loaded without the status RPC; `non-conforming`: ambiguous source,
 * marker mismatch or an output outside the contract; `unknown`: no answer in time, or another failure; `ok`: a
 * conforming status.
 */
export type IntegrationRuntimeState = "absent" | "inactive" | "failed" | "unsupported" | "non-conforming" | "unknown" | "ok"

export type IntegrationStatusRead =
  | { state: Exclude<IntegrationRuntimeState, "ok"> }
  | { state: "ok"; status: IntegrationStatus }

/** Calls `rpcID.method(input)` in the read's Location; rejects with the native error. */
export type IntegrationRpcCall = (rpcID: string, method: "status", signal: AbortSignal) => Promise<unknown>

/**
 * A string that may disclose a path: a separator, a drive letter or a home `~`. Display fields of an RPC output
 * that look like one make the output non-conforming, beyond the contract's own pattern (spec change §4.2).
 */
export function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /(?:^|[^\p{L}\p{N}])\p{L}:/u.test(value) || /(?:^|\s)~/.test(value)
}

// The native SDK throws a declared RPC error with its body's fields: no registration or method is `unsupported`,
// an output OpenCode refused against the integration's own definition is `non-conforming`, anything else `unknown`.
function rpcErrorState(error: unknown): "unsupported" | "non-conforming" | "unknown" {
  const body = error as { _tag?: unknown; type?: unknown } | null
  if (body?._tag !== "RpcError") return "unknown"
  if (body.type === "rpc.unavailable" || body.type === "rpc.method_not_found") return "unsupported"
  return body.type === "rpc.invalid_output" ? "non-conforming" : "unknown"
}

/** Reads every recognised, loaded integration's status, at most `concurrency` calls at a time. */
export async function readIntegrationStatuses(
  recognitions: readonly IntegrationRecognition[],
  call: IntegrationRpcCall,
  options: { signal?: AbortSignal; timeoutMs?: number; concurrency?: number } = {},
): Promise<IntegrationStatusRead[]> {
  const results: IntegrationStatusRead[] = new Array(recognitions.length)
  let next = 0
  const worker = async () => {
    while (next < recognitions.length) {
      const index = next++
      results[index] = await readOne(recognitions[index]!, call, options)
    }
  }
  const workers = Math.min(options.concurrency ?? INTEGRATION_STATUS_CONCURRENCY, recognitions.length)
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

async function readOne(recognition: IntegrationRecognition, call: IntegrationRpcCall,
  options: { signal?: AbortSignal; timeoutMs?: number }): Promise<IntegrationStatusRead> {
  if (recognition.ways.length === 0) return { state: "absent" }
  if (recognition.ambiguous) return { state: "non-conforming" }
  const runtime = recognition.runtime
  if (!runtime) return { state: "inactive" }
  if (runtime.state.status === "failed") return { state: "failed" }
  // `features.rpc` is not reliable (a plugin registering in `setup` may lack it): the native error decides.
  if (options.signal?.aborted) return { state: "unknown" }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? INTEGRATION_STATUS_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let output: unknown
  try {
    // A client that ignores the signal is still bounded.
    output = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(new Error("timeout"))
      signal.addEventListener("abort", abort, { once: true })
      call(recognition.entry.rpc, "status", signal).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  } catch (error) {
    return { state: signal.aborted ? "unknown" : rpcErrorState(error) }
  }
  const read = readIntegrationRpcOutput("status.output", output)
  if (!read.ok) return { state: "non-conforming" }
  const status = read.value
  // Marker mismatch: the package answers for another integration or family.
  if (status.integration.id !== recognition.entry.id || status.integration.family !== recognition.entry.family) return { state: "non-conforming" }
  if (status.host?.appVersion !== undefined && looksLikePath(status.host.appVersion)) return { state: "non-conforming" }
  return { state: "ok", status }
}
