import { isPlainObject } from "./merge-patch"
import type { ConfigWriteCheck } from "./service"
import type { SettingsDoc } from "./yaml-doc-store"
import { SIDECARS_OVER_DIRECT_HTTPS } from "../server/sidecar-direct-https"

/** Server-owner settings that widen host-only access: only the host itself may change them. */
const HOST_ONLY_SERVER_KEYS = [SIDECARS_OVER_DIRECT_HTTPS] as const

export class HostOnlySettingError extends Error {
  constructor() {
    super("This setting can be changed on the host only")
  }
}

/**
 * The config write check for a request: a non-local request may not change a host-only
 * setting, by any route or owner, including by deleting the whole server owner. It compares
 * the authoritative document a write starts from with its result, so neither a stale cache
 * nor a concurrent host edit lets the request flip one. Other keys stay writable.
 */
export function hostOnlyServerCheck(localRequest: boolean): ConfigWriteCheck | undefined {
  if (localRequest) return undefined
  return (before: SettingsDoc, after: SettingsDoc) => {
    for (const key of HOST_ONLY_SERVER_KEYS) {
      if (enabled(before.server, key) !== enabled(after.server, key)) throw new HostOnlySettingError()
    }
  }
}

function enabled(owner: unknown, key: string): boolean {
  return isPlainObject(owner) && owner[key] === true
}
