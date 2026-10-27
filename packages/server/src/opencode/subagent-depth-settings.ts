import { createHash } from "node:crypto"
import type { PluginControlLocation, SubagentDepthCapability, SubagentDepthSnapshot } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError, type PluginControls } from "./plugin-controls"
import type { PluginControlDocument } from "./plugin-control-document"
import { editNativeSetting, readNativeSetting } from "./native-setting-document"
import { readRuntimeContract } from "./compatibility/negotiate"

const keys = ["experimental", "subagent_depth"]

function depth(value: unknown): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PluginControlsError("Invalid native subagent depth", "invalid")
  return value as number
}

export function subagentDepthCapability(document: Record<string, any>): SubagentDepthCapability | null {
  const value = document.components?.schemas?.["Config.InfoEncoded"]?.properties?.experimental?.properties?.subagent_depth
  if (!value || value.type !== "integer" || value.minimum !== 0) return null
  if (value.maximum !== undefined && (!Number.isSafeInteger(value.maximum) || value.maximum < 0)) return null
  if (value.default !== undefined && (!Number.isSafeInteger(value.default) || value.default < 0
    || value.maximum !== undefined && value.default > value.maximum)) return null
  return { minimum: 0, ...(value.maximum === undefined ? {} : { maximum: value.maximum }),
    ...(value.default === undefined ? {} : { default: value.default }) }
}

function expectation(document: PluginControlDocument): string {
  return createHash("sha256").update(JSON.stringify([
    document.requestedPath, document.writePath, document.exists, document.mode, document.byteOrderMark, document.text,
  ])).digest("hex")
}

/** Only the owned Location's project layer; never edits permissions or reloads Locations. */
export class SubagentDepthSettings {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments" | "editConfigDocument">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection">) {}

  private async context(workspaceId: string, location: PluginControlLocation) {
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    // Document acquisition proves directory ownership before the schema request.
    const snapshot = await this.documents.readConfigDocuments(workspaceId, location)
    connection.assertCurrent()
    const contract = await readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    return { ...snapshot, connection, capability: subagentDepthCapability(contract) }
  }

  async read(workspaceId: string, location: PluginControlLocation): Promise<SubagentDepthSnapshot> {
    const context = await this.context(workspaceId, location)
    // OpenCode reads the whole `experimental` object of the highest-priority document that has one
    // (`Config.latest`), without merging, so a project block without the depth hides the global depth.
    const experimental = [...context.entries].reverse().find(entry => entry.type === "document" && entry.info.experimental !== undefined)
    const configured = experimental?.type === "document" ? experimental.info.experimental?.subagent_depth : undefined
    const effectiveDepth = configured === undefined ? context.capability?.default ?? null : depth(configured)
    const project = context.documents.find(item => item.scope === "project")
    return { location: context.location, capability: context.capability, effectiveDepth,
      project: project ? { path: project.path, depth: depth(readNativeSetting(project.document, keys)),
        expectation: expectation(project.document) } : null }
  }

  async update(workspaceId: string, location: PluginControlLocation, value: number | null, expected: string): Promise<void> {
    const context = await this.context(workspaceId, location)
    const capability = context.capability
    if (!capability || !context.documents.some(item => item.scope === "project"))
      throw new PluginControlsError("Native subagent depth editing is unavailable", "unavailable")
    const validated = value === null ? null : depth(value)
    if (value !== null && (validated === null || validated < capability.minimum
      || capability.maximum !== undefined && validated > capability.maximum))
      throw new PluginControlsError("Subagent depth is outside the native contract", "invalid")
    await this.documents.editConfigDocument(workspaceId, location, "project", document => {
      context.connection.assertCurrent()
      if (expectation(document) !== expected) throw new PluginControlsError("OpenCode configuration changed; refresh before saving", "conflict")
      if (value !== null) return editNativeSetting(document, keys, value)
      // An emptied project `experimental` object would still hide every inherited experimental setting.
      const removed = editNativeSetting(document, keys, undefined)
      const remaining = { ...document, text: document.byteOrderMark ? removed.slice(1) : removed }
      const parent = readNativeSetting(remaining, ["experimental"])
      return parent && typeof parent === "object" && !Array.isArray(parent) && !Object.keys(parent).length
        ? editNativeSetting(remaining, ["experimental"], undefined) : removed
    })
    context.connection.assertCurrent()
  }
}
