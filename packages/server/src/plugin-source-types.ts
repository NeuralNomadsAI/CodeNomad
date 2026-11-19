import type { PluginControlLocation, PluginControlScope } from "./api-types"

/** Adds one registry or Git package spec as a string at the end of `plugins`. */
export interface PluginSourceAddRequest {
  location: PluginControlLocation
  scope: PluginControlScope
  spec: string
}

/** Removes `plugins[entryIndex]` of the scope's document only while it still declares `target`, with the exact
 * activation rules of its plugin ID in that document; or, with `pluginId`, the exact rules of an orphan ID there. */
export type PluginSourceRemoveRequest = {
  location: PluginControlLocation
  scope: PluginControlScope
  expectedRevision: string
} & ({ target: string; entryIndex: number } | { pluginId: string })

/** Durable configured state only: the daemon reports loading through `plugin.list` afterwards. `spec` is the added or
 * removed target, or the plugin ID whose rules were removed. */
export interface PluginSourceMutationResponse {
  scope: PluginControlScope
  spec: string
  reloadPending: true
}

/** `duplicate`: the package is already declared in an effective scope; `plugin-id`: the spec names
 * a plugin ID or activation selector; `stale`: the entry changed since it was displayed;
 * `timeout`: OpenCode did not answer within the add deadline; `global-only`: a recognised `native`
 * integration added to Project (D18); `dependent-rule`: removing the source would turn a bare plugin ID in a
 * configuration CodeNomad does not edit into a package spec. */
export type PluginSourceErrorCode = "invalid-spec" | "local-path" | "duplicate" | "plugin-id" | "stale" | "timeout" | "global-only" | "dependent-rule"
