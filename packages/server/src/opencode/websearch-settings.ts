import type { PluginControlLocation, PluginControlScope, WebSearchSelection, WebSearchSettingsSnapshot } from "../api-types"
import type { PluginControls } from "./plugin-controls"
import { readNativeSetting, editNativeSetting } from "./native-setting-document"

function selection(value: unknown): WebSearchSelection {
  if (value === false) return false
  if (value && typeof value === "object" && "provider" in value && typeof value.provider === "string") return value.provider
  return null
}

export class WebSearchSettings {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments" | "editConfigDocument">) {}
  async read(workspaceId: string, location: PluginControlLocation): Promise<WebSearchSettingsSnapshot> {
    const snapshot = await this.documents.readConfigDocuments(workspaceId, location)
    let effective: WebSearchSelection = null
    for (const entry of snapshot.entries) {
      if (entry.type === "document" && entry.info.websearch !== undefined) effective = selection(entry.info.websearch)
    }
    return { location: snapshot.location, effective, scopes: snapshot.documents.map(({ scope, path, document }) => ({
      scope, path, selection: selection(readNativeSetting(document, ["websearch"])),
    })) }
  }
  async update(workspaceId: string, location: PluginControlLocation, scope: PluginControlScope, provider: WebSearchSelection) {
    await this.documents.editConfigDocument(workspaceId, location, scope, document => {
      const previous = readNativeSetting(document, ["websearch"])
      return typeof provider === "string" && previous && typeof previous === "object" && !Array.isArray(previous)
        ? editNativeSetting(document, ["websearch", "provider"], provider)
        : editNativeSetting(document, ["websearch"], provider === null ? undefined : provider === false ? false : { provider })
    })
  }
}
