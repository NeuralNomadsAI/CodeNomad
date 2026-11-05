import { OpenCode } from "@opencode/client"
import { z } from "zod"
import { boundedResponseFetch, BoundedResponseError } from "../bounded-response-fetch"
import { ExplicitContractError, negotiateRuntime } from "../compatibility/negotiate"
import { initialServerCapabilities, type ServerCapabilities } from "./capabilities"
import { ExplicitEndpointError, normalizeExplicitOrigin, type ResolveAddresses } from "./endpoint"
import { createExplicitTransport } from "./transport"
import { SERVER_CONNECTION_LIMITS } from "./types"

const candidateSchema = z.object({
  origin: z.string().max(2_048),
  credentials: z.object({ username: z.string().max(8_192).refine(value => !value.includes(":")), password: z.string().max(8_192) }).strict().optional(),
}).strict().refine(value => !value.credentials || Buffer.byteLength(JSON.stringify(value.credentials), "utf8") <= 16 * 1024)
export type ProbeCandidate = z.infer<typeof candidateSchema>
export type ProbePhase = "validation" | "credentials" | "contract" | "info" | "operation"
export type ProbeCode = "invalid_origin" | "invalid_credentials" | "needs_credentials" | "missing_contract" | "auth"
  | "forbidden_address" | "https_required" | "dns" | "network" | "tls" | "redirect" | "timeout" | "response_limit"
export class ServerProbeError extends Error {
  constructor(readonly code: ProbeCode, readonly phase: ProbePhase, readonly capabilities?: ServerCapabilities["features"]) { super(code); this.name = "ServerProbeError" }
}
export interface ServerProbeResult {
  version: string | null
  capabilities: ServerCapabilities["features"]
  checkedAt: string
  diagnostic: { code: "info_unavailable"; phase: "info" } | null
}

/** Validate before DNS and keep the candidate outside registry/credential owners. */
export function parseProbeCandidate(value: unknown): ProbeCandidate {
  const parsed = candidateSchema.safeParse(value)
  if (!parsed.success) throw new ServerProbeError("invalid_credentials", "validation")
  return { ...parsed.data, origin: normalizeExplicitOrigin(parsed.data.origin) }
}

/** Only consumed read-only contracts and canonical info; no functional/location discovery. */
export async function probeExplicitCandidate(candidate: ProbeCandidate, signal: AbortSignal, current: () => void,
  resolve?: ResolveAddresses): Promise<ServerProbeResult> {
  let phase: ProbePhase = "contract"
  let transportFailure: unknown
  let capabilities: ServerCapabilities["features"] | undefined
  try {
    const transport = createExplicitTransport({ ...candidate, signal }, resolve)
    const bounded = boundedResponseFetch(transport.fetch, signal, current, SERVER_CONNECTION_LIMITS.probeMaxBytes)
    const fetch: typeof globalThis.fetch = async (input, init) => {
      transportFailure = undefined
      try {
        const response = await bounded(input, init)
        current()
        if (response.status === 401 || response.status === 403) throw new ServerProbeError("auth", phase)
        return response
      } catch (error) { transportFailure = error; throw error }
    }
    await negotiateRuntime({ url: candidate.origin }, fetch, signal, "explicit-e1")
    current()
    capabilities = initialServerCapabilities({ kind: "explicit", id: "candidate", label: "candidate", origin: candidate.origin }, 0).features
    for (const value of Object.values(capabilities)) if (value.state === "unknown") {
      value.state = "available"; value.reason.code = "contractVerified"; value.evidence = "nativeContract"
    }
    phase = "info"
    let version: string | null = null, diagnostic: ServerProbeResult["diagnostic"] = null
    try {
      const info = await OpenCode.make({ baseUrl: candidate.origin, fetch }).server.info({ signal })
      current()
      // Unstructured/custom identity strings stay unavailable, never echoing upstream prose.
      if (typeof info.version === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(info.version)
        && !Object.values(candidate.credentials ?? {}).some(value => value.length > 0 && info.version.includes(value))) version = info.version
      else diagnostic = { code: "info_unavailable", phase }
    } catch (error) {
      current()
      // The official client wraps dispatch failures; retain only our own boundary error.
      if (transportFailure) throw transportFailure
      if (error instanceof ServerProbeError || error instanceof BoundedResponseError || error instanceof ExplicitEndpointError) throw error
      diagnostic = { code: "info_unavailable", phase }
    }
    current()
    return { version, capabilities, checkedAt: new Date().toISOString(), diagnostic }
  } catch (error) {
    if (error instanceof ServerProbeError) throw new ServerProbeError(error.code, error.phase, capabilities)
    if (signal.aborted) throw signal.reason
    if (error instanceof ExplicitContractError) throw new ServerProbeError("missing_contract", phase)
    if (error instanceof BoundedResponseError) throw new ServerProbeError("response_limit", phase, capabilities)
    if (error instanceof ExplicitEndpointError) throw new ServerProbeError(error.code === "probe_path" || error.code === "custom_ca_unsupported" ? "network" : error.code, phase, capabilities)
    throw new ServerProbeError("network", phase, capabilities)
  }
}
