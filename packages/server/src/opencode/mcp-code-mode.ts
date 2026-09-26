import type { McpCodeModeEntry, PluginControlLocation, PluginControlScope } from "../api-types"
import type { PluginControls } from "./plugin-controls"
import { PluginControlsError } from "./plugin-controls"
import { readNativeSetting, editNativeSetting } from "./native-setting-document"

function serverConfig(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "type" in value && ["local", "remote"].includes(String(value.type)))
}

export class McpCodeMode {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments" | "editConfigDocument">) {}
  async read(workspaceId: string, location: PluginControlLocation): Promise<McpCodeModeEntry[]> {
    const snapshot = await this.documents.readConfigDocuments(workspaceId, location)
    const effective = new Map<string, boolean>()
    for (const entry of snapshot.entries) {
      if (entry.type !== "document") continue
      // Native merge replaces an entire same-name server object. Never inherit
      // a codemode property from a lower document once that object is replaced.
      for (const [name, config] of Object.entries(entry.info.mcp?.servers ?? {})) {
        effective.set(name, config.codemode !== false)
      }
    }
    return [...effective].map(([server, mode]) => ({ server, effective: mode,
      scopes: snapshot.documents.flatMap(({ scope, path, document }) => {
        const config = readNativeSetting(document, ["mcp", "servers", server])
        return serverConfig(config) ? [{ scope, path, mode: typeof config.codemode === "boolean" ? config.codemode : null }] : []
      }),
    }))
  }
  async update(workspaceId: string, location: PluginControlLocation, scope: PluginControlScope, server: string, mode: boolean | null) {
    await this.documents.editConfigDocument(workspaceId, location, scope, document => {
      const config = readNativeSetting(document, ["mcp", "servers", server])
      if (!serverConfig(config)) throw new PluginControlsError("MCP server is not configured in this document", "conflict")
      // Do not clone inherited server credentials into a project override. Only
      // edit a declared source, preserving its original substitutions and fields.
      return editNativeSetting(document, ["mcp", "servers", server, "codemode"], mode === null ? undefined : mode)
    })
  }
}
