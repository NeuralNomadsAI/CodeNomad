import type { Endpoint } from "@opencode/client/service"

export interface RuntimeIdentity {
  version: string
  pid: number
  discovery: "status" | "health"
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
  if (/^2\.0\.[0-3]$/.test(identity.version)) return "legacy"
  if (/^2\.0\.[45]$/.test(identity.version)) return "modern"
  const beta = /^0\.0\.0-beta-(\d+)$/.exec(identity.version)?.[1]
  const audited = new Set([18866, 18955, 18965, 18985, 18992, 18999, 19059, 19086,
    19124, 19129, 19133, 19135, 19151, 19157, 19187, 19192, 19215, 19213,
    19228, 19234, 19242, 19266, 19271, 19275, 19278, 19283, 19288, 19289,
    19296, 19365, 19378, 19381, 19398, 19419, 19422, 19425, 19500, 19507])
  return beta && audited.has(Number(beta)) ? "legacy" : "unknown"
}
