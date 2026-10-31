import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { PluginControlLocation, SubagentDepthCapability, SubagentDepthSnapshot } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError, type PluginControls } from "./plugin-controls"
import type { PluginControlDocument } from "./plugin-control-document"
import { editNativeSetting, readNativeSetting, removeEmptyNativeObject, withEditedText } from "./native-setting-document"
import { readRuntimeContract } from "./compatibility/negotiate"
import { imageSettingsCapability } from "./image-settings"
import { maskedBy, samePath } from "./experimental-layers"
import { NESTING_AGENT, hasNestingRule, nestingEffect, nestingToolHidden, withNestingRule, withoutNestingRule } from "./subagent-nesting"
import type { ServiceConnection } from "../workspaces/opencode-service"

const keys = ["experimental", "subagent_depth"]

/** The text without the project `experimental` object when, apart from the `removing` property, it
 * changes nothing OpenCode reads: no properties, or only a `media_blob` (written by Settings → Images)
 * equal to the one removal would expose (`inherited` is `undefined` when that is uncertain). */
function withoutRedundantExperimental(document: PluginControlDocument, inherited: boolean | undefined,
  removing?: string): string | undefined {
  return removeEmptyNativeObject(document, ["experimental"], value => {
    const properties = Object.keys(value).filter(key => key !== removing)
    return properties.length === 0
      || inherited !== undefined && properties.length === 1 && properties[0] === "media_blob" && value.media_blob === inherited
  })
}

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

/** General's resolved permission rules; `undefined` when unreadable or General is missing. */
async function generalRules(connection: ServiceConnection, directory: string) {
  try {
    const agents = (await connection.client.agent.list({ location: { directory } }, { signal: AbortSignal.timeout(5_000) })).data
    const general = Array.isArray(agents) ? agents.find(agent => agent.id === NESTING_AGENT) : undefined
    return Array.isArray(general?.permissions) ? general.permissions : undefined
  } catch { return undefined }
}

/** Only the owned Location's project layer: the depth override and, with it, the marked rule letting OpenCode's
 * General subagent launch subagents; never reloads Locations. */
export class SubagentDepthSettings {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments" | "editConfigDocument">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection" | "getServicePathStyle">) {}

  private async context(workspaceId: string, location: PluginControlLocation) {
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    // Document acquisition proves directory ownership before the schema request.
    const snapshot = await this.documents.readConfigDocuments(workspaceId, location)
    connection.assertCurrent()
    const [contract, rules] = await Promise.all([
      readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000)),
      generalRules(connection, snapshot.location.directory),
    ])
    connection.assertCurrent()
    return { ...snapshot, connection, capability: subagentDepthCapability(contract),
      mediaStorage: imageSettingsCapability(contract).mediaStorage, rules }
  }

  /** The `media_blob` removing the project `experimental` object would expose, only when certain: the
   * runtime declares it, and the next native object belongs to the Global write target and matches its
   * fresh document exactly (native entries lag behind writes and normalize what they load). */
  private exposedMediaStorage(context: Awaited<ReturnType<SubagentDepthSettings["context"]>>, target: string) {
    const global = context.documents.find(item => item.scope === "global")
    const lower = maskedBy(context.entries, target, false)
    if (!context.mediaStorage || !global?.document.exists || lower?.path === undefined || !samePath(lower.path, global.path))
      return undefined
    let fresh: unknown
    try { fresh = readNativeSetting(global.document, ["experimental"]) } catch { return undefined }
    return isDeepStrictEqual(fresh, lower.info?.experimental) ? lower.info?.experimental?.media_blob === true : undefined
  }

  async read(workspaceId: string, location: PluginControlLocation): Promise<SubagentDepthSnapshot> {
    const context = await this.context(workspaceId, location)
    // OpenCode reads the whole `experimental` object of the highest-priority document that has one
    // (`Config.latest`), without merging, so a project block without the depth hides the global depth.
    const experimental = [...context.entries].reverse().find(entry => entry.type === "document" && entry.info.experimental !== undefined)
    const configured = experimental?.type === "document" ? experimental.info.experimental?.subagent_depth : undefined
    const effectiveDepth = configured === undefined ? context.capability?.default ?? null : depth(configured)
    const project = context.documents.find(item => item.scope === "project")
    // OpenCode's resolved rules decide; it matches permissions case-insensitively on Windows execution hosts.
    const ignoreCase = this.manager.getServicePathStyle(workspaceId) === "win32"
    const effect = context.rules && nestingEffect(context.rules, ignoreCase)
    return { location: context.location, capability: context.capability, effectiveDepth,
      nesting: effect ? { effect, ...(nestingToolHidden(context.rules!, ignoreCase) ? { hidden: true as const } : {}) } : null,
      project: project ? { path: project.path, depth: depth(readNativeSetting(project.document, keys)),
        expectation: expectation(project.document),
        ...(withoutRedundantExperimental(project.document, this.exposedMediaStorage(context, project.path)) === undefined
          ? {} : { emptyExperimental: true }) } : null }
  }

  async update(workspaceId: string, location: PluginControlLocation, value: number | null, expected: string): Promise<void> {
    const context = await this.context(workspaceId, location)
    const capability = context.capability
    const project = context.documents.find(item => item.scope === "project")
    if (!capability || !project)
      throw new PluginControlsError("Native subagent depth editing is unavailable", "unavailable")
    const exposed = this.exposedMediaStorage(context, project.path)
    const validated = value === null ? null : depth(value)
    if (value !== null && (validated === null || validated < capability.minimum
      || capability.maximum !== undefined && validated > capability.maximum))
      throw new PluginControlsError("Subagent depth is outside the native contract", "invalid")
    await this.documents.editConfigDocument(workspaceId, location, "project", document => {
      context.connection.assertCurrent()
      if (expectation(document) !== expected) throw new PluginControlsError("OpenCode configuration changed; refresh before saving", "conflict")
      // An emptied project `experimental` object would still hide every inherited experimental setting,
      // so it goes in one edit that keeps the comments written inside it.
      const text = value !== null ? editNativeSetting(document, keys, value)
        : withoutRedundantExperimental(document, exposed, keys[1]) ?? editNativeSetting(document, keys, undefined)
      // A project override is the user's consent to subagents nesting up to it, so the marked rule
      // follows the override: written with any depth, removed by Inherit only.
      const edited = withEditedText(document, text)
      if (value === null) return withoutNestingRule(edited) ?? text
      // Without a General block that can take it (see `withNestingRule`), only the depth is saved.
      return hasNestingRule(edited) ? text : withNestingRule(edited) ?? text
    })
    context.connection.assertCurrent()
  }
}
