import type { PluginControlLocation, PluginControlScope } from "./api-types"

/** Adds one registry or Git package spec as a string at the end of `plugins`. */
export interface PluginSourceAddRequest {
  location: PluginControlLocation
  scope: PluginControlScope
  spec: string
}

/** Removes `plugins[entryIndex]` of the scope's document only while it still declares `target`. */
export interface PluginSourceRemoveRequest {
  location: PluginControlLocation
  scope: PluginControlScope
  target: string
  entryIndex: number
  expectedRevision: string
}

/** Durable configured state only: the daemon reports loading through `plugin.list` afterwards. */
export interface PluginSourceMutationResponse {
  scope: PluginControlScope
  spec: string
  reloadPending: true
}

/** `duplicate`: the package is already declared in an effective scope; `plugin-id`: the spec names
 * a plugin ID or activation selector; `stale`: the entry changed since it was displayed;
 * `timeout`: OpenCode did not answer within the add deadline; `global-only`: a recognised `native`
 * integration added to Project (D18). */
export type PluginSourceErrorCode = "invalid-spec" | "local-path" | "duplicate" | "plugin-id" | "stale" | "timeout" | "global-only"
