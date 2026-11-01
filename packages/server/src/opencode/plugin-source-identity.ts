import { createHmac, randomBytes } from "node:crypto"
import type { PluginConfiguredSource, PluginControlLocation } from "../api-types"

const key = randomBytes(32)
const connections = new WeakMap<object, string>()

/** Display correlation only, bound to this backend and exact native connection/document/source. */
export function integrationSourceIdentity(instance: string, location: PluginControlLocation, connection: object,
  source: Pick<PluginConfiguredSource, "scope" | "path"> & Partial<Pick<PluginConfiguredSource, "target" | "entryIndex">>): string {
  let identity = connections.get(connection)
  if (!identity) connections.set(connection, identity = randomBytes(16).toString("hex"))
  return createHmac("sha256", key).update(JSON.stringify([instance, location.directory, identity,
    source.scope, source.path, source.target, source.entryIndex])).digest("hex")
}
