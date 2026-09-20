import type { Endpoint } from "@opencode/client/service"

export interface RuntimeIdentity {
  version: string
  pid: number
  discovery: "status" | "health" | "info"
  /** Filled only by a successful, authenticated schema negotiation. */
  contract?: { profile?: Exclude<ContractProfile, "unknown"> }
}

// Keep authenticated daemon metadata out of public endpoints and credentials.
const RUNTIME_IDENTITY = Symbol.for("codenomad.opencode.runtime")
export function rememberRuntime(endpoint: Endpoint, identity: RuntimeIdentity): void {
  Object.defineProperty(endpoint, RUNTIME_IDENTITY, { value: Object.freeze({ ...identity, contract: {} }) })
}
export function runtimeIdentity(endpoint: Endpoint): RuntimeIdentity | undefined {
  return (endpoint as Endpoint & { [RUNTIME_IDENTITY]?: RuntimeIdentity })[RUNTIME_IDENTITY]
}

export type ContractProfile = "modern" | "legacy" | "unknown"
export function contractProfile(identity: RuntimeIdentity | undefined): ContractProfile {
  // Custom embedded/test lifecycles that don't negotiate use the pinned contract.
  if (!identity) return "modern"
  if (identity.contract?.profile) return identity.contract.profile
  if (identity.version === "2.0.11") return "modern"
  return "unknown"
}
