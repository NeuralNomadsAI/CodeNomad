import { applyMergePatch, isPlainObject } from "./merge-patch"
import { SIDECARS_OVER_DIRECT_HTTPS } from "../server/sidecar-direct-https"

/** Server-owner settings that widen host-only access: only the host itself may change them. */
const HOST_ONLY_SERVER_KEYS = [SIDECARS_OVER_DIRECT_HTTPS] as const

export class HostOnlySettingError extends Error {
  constructor() {
    super("This setting can be changed on the host only")
  }
}

/**
 * Refuses a server-owner merge patch from a non-local request when it would change a
 * host-only setting, including by deleting the whole owner. Other keys stay writable.
 */
export function assertHostOnlyServerPatch(localRequest: boolean, current: unknown, patch: unknown): void {
  if (localRequest) return
  const next = applyMergePatch(current, patch)
  for (const key of HOST_ONLY_SERVER_KEYS) {
    if (enabled(current, key) !== enabled(next, key)) throw new HostOnlySettingError()
  }
}

function enabled(owner: unknown, key: string): boolean {
  return isPlainObject(owner) && owner[key] === true
}
