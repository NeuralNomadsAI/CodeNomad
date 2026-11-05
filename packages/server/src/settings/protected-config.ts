import { isDeepStrictEqual } from "node:util"
import { applyMergePatch, isPlainObject } from "./merge-patch"

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/** Generic config writes reserve this subtree for the internal server registry. */
export function assertOpenCodeServersPatch(current: unknown, patch: unknown, owner?: string): void {
  if (owner !== undefined && owner !== "server") return
  const before = owner === "server" ? current : isPlainObject(current) ? current.server : undefined
  const change = owner === "server" ? patch : isPlainObject(patch) ? patch.server : patch
  if (isPlainObject(change) && has(change, "opencodeServers")) {
    throw new Error("OpenCode server profiles require the server registry")
  }
  const candidate = applyMergePatch(current, patch)
  const after = owner === "server" ? candidate : isPlainObject(candidate) ? candidate.server : undefined
  const present = (value: unknown) => isPlainObject(value) && has(value, "opencodeServers")
  if (present(before) !== present(after)
    || !isDeepStrictEqual(isPlainObject(before) ? before.opencodeServers : undefined,
      isPlainObject(after) ? after.opencodeServers : undefined)) {
    throw new Error("OpenCode server profiles require the server registry")
  }
}
