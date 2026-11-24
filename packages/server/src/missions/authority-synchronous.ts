import { MissionAuthorityError, rejectAuthority } from "./authority-protocol"

/** Approval is synchronous and literal. Observe a genuine Promise's rejection
 * only to avoid process termination; never await it or assimilate a thenable. */
export function assertSynchronousAuthorityGuard(check: () => true,
  code: "trust-unavailable" | "untrusted-signer" | "policy-unqualified"): true {
  let result: unknown
  try { result = check() }
  catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority(code) }
  if (result !== true) {
    if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => undefined)
    rejectAuthority(code)
  }
  return true
}
