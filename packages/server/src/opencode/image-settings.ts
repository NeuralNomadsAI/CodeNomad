import path from "node:path"
import { Service } from "@opencode/client/service"
import type { ImageGenerationSelection, ImageModelOption, ImageSettingsSnapshot, PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError, type PluginControls } from "./plugin-controls"
import { editNativeSetting, readNativeSetting } from "./native-setting-document"
import { readRuntimeContract } from "./compatibility/negotiate"

const GENERATION = ["experimental", "image_generate"]
const MEDIA_STORAGE = ["experimental", "media_blob"]
/** The native `ConfigModel.Selection` string form. */
export const IMAGE_MODEL_REF = /^[^/#]+\/[^#]+(?:#[^#]+)?$/

type ExperimentalProperties = Record<string, unknown> | undefined

export function imageSettingsCapability(document: Record<string, any>) {
  const properties: ExperimentalProperties = document.components?.schemas?.["Config.InfoEncoded"]?.properties?.experimental?.properties
  const has = (key: string) => Boolean(properties && typeof properties === "object" && properties[key])
  return { generation: has("image_generate"), mediaStorage: has("media_blob") }
}

/** Reads `experimental.image_generate` as OpenCode does: `true` or an object enables it, an object may name a model. */
export function imageGenerationSelection(value: unknown): ImageGenerationSelection {
  if (value === true) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const model = (value as { model?: unknown }).model
  if (typeof model === "string") return IMAGE_MODEL_REF.test(model) ? model : true
  if (model && typeof model === "object") {
    const { providerID, model: id, variant } = model as Record<string, unknown>
    if (typeof providerID === "string" && typeof id === "string")
      return `${providerID}/${id}${typeof variant === "string" ? `#${variant}` : ""}`
  }
  return true
}

type Entry = { type: string; path?: string; info?: { experimental?: Record<string, unknown> } }
/** Configuration documents, highest priority first. */
const documents = (entries: readonly unknown[]) =>
  entries.filter((entry): entry is Entry & { type: "document" } => Boolean(entry) && (entry as Entry).type === "document").reverse()

const pathsFor = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? path.win32 : path.posix
function samePath(left: string, right: string) {
  const paths = pathsFor(left)
  const normalize = (value: string) => paths.normalize(value).replace(/[\\/]$/, "")
  return paths === path.win32 ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right)
}

const located = (entry: Entry | undefined) => !entry ? undefined : entry.path === undefined ? {} : { path: entry.path }

/** The native document that decides a value, when it is not the Global document this group writes. */
function override(winner: Entry | undefined, target: string): { path?: string } | undefined {
  return winner?.path !== undefined && samePath(winner.path, target) ? undefined : located(winner)
}

/** The lower-priority document whose whole `experimental` object a new one in `target` would hide
 * (`entries` lowest priority first; a missing target sits just before its directory, as natively). */
function maskedBy(entries: readonly unknown[], target: string, targetHasExperimental: boolean): Entry | undefined {
  if (targetHasExperimental) return undefined
  const list = entries as Array<Entry | undefined>
  const own = list.findIndex(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, target))
  const directory = list.findIndex(entry => entry?.type === "directory" && entry.path !== undefined
    && samePath(entry.path, pathsFor(target).dirname(target)))
  const order = own >= 0 ? own : directory >= 0 ? directory - 0.5 : list.length
  let winner = -1
  list.forEach((entry, index) => { if (entry?.type === "document" && entry.info?.experimental !== undefined) winner = index })
  return winner >= 0 && winner < order ? list[winner] : undefined
}

/** Global scope only: OpenCode reads `media_blob` from the whole `experimental` object of the
 * highest-priority document that has one, so a project block would hide inherited experimental settings. */
export class ImageSettings {
  constructor(private readonly configuration: Pick<PluginControls, "readConfigDocuments" | "editConfigDocument">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection">) {}

  private async context(workspaceId: string, location: PluginControlLocation) {
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    // Document acquisition proves directory ownership before any native request.
    const snapshot = await this.configuration.readConfigDocuments(workspaceId, location)
    connection.assertCurrent()
    const contract = await readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    return { ...snapshot, connection, capability: imageSettingsCapability(contract) }
  }

  /** `null` when the native catalog cannot be read; the configured choice stays readable without it. */
  private async imageModels(context: Awaited<ReturnType<ImageSettings["context"]>>): Promise<ImageModelOption[] | null> {
    const url = new URL("/api/model", context.connection.endpoint.url)
    url.searchParams.set("location[directory]", context.location.directory)
    url.searchParams.set("types", "image")
    let data: unknown
    try {
      const response = await context.connection.fetch(url, {
        headers: Service.headers(context.connection.endpoint), redirect: "error", signal: AbortSignal.timeout(5_000),
      })
      if (response.ok) data = (await response.json() as { data?: unknown }).data
      else await response.body?.cancel()
    } catch { data = undefined }
    // Every catalog outcome, failures included, still belongs to the connection that produced the rest of the snapshot.
    context.connection.assertCurrent()
    if (!Array.isArray(data)) return null
    return data.flatMap((model: any) => typeof model?.providerID === "string" && typeof model?.id === "string"
      ? [{ ref: `${model.providerID}/${model.id}`, name: typeof model.name === "string" && model.name ? model.name : model.id }] : [])
  }

  async read(workspaceId: string, location: PluginControlLocation): Promise<ImageSettingsSnapshot> {
    const context = await this.context(workspaceId, location)
    const global = context.documents.find(item => item.scope === "global")
    const settings = documents(context.entries)

    let generation: ImageSettingsSnapshot["generation"] = null
    if (context.capability.generation && global) {
      // OpenCode reads this one field from the highest-priority document that sets it.
      const winner = settings.find(entry => entry.info?.experimental?.image_generate !== undefined)
      const overridden = override(winner, global.path)
      generation = {
        global: imageGenerationSelection(readNativeSetting(global.document, GENERATION)),
        effective: imageGenerationSelection(winner?.info?.experimental?.image_generate),
        ...(overridden ? { override: overridden } : {}),
        models: await this.imageModels(context),
      }
    }

    let mediaStorage: ImageSettingsSnapshot["mediaStorage"] = null
    if (context.capability.mediaStorage && global) {
      // OpenCode reads the whole `experimental` object of the highest-priority document that has one.
      const winner = settings.find(entry => entry.info?.experimental !== undefined)
      const overridden = override(winner, global.path)
      mediaStorage = {
        global: readNativeSetting(global.document, MEDIA_STORAGE) === true,
        effective: winner?.info?.experimental?.media_blob === true,
        ...(overridden ? { override: overridden } : {}),
      }
    }
    const blocked = global && (generation || mediaStorage)
      ? located(maskedBy(context.entries, global.path, readNativeSetting(global.document, ["experimental"]) !== undefined)) : undefined
    return { location: context.location, generation, mediaStorage, ...(blocked ? { blockedBy: blocked } : {}) }
  }

  async update(workspaceId: string, location: PluginControlLocation,
    change: { generation: ImageGenerationSelection } | { mediaStorage: boolean }): Promise<void> {
    const context = await this.context(workspaceId, location)
    const generation = "generation" in change
    if (!(generation ? context.capability.generation : context.capability.mediaStorage))
      throw new PluginControlsError("This OpenCode configuration has no such image setting", "unavailable")
    if (generation && typeof change.generation === "string" && !IMAGE_MODEL_REF.test(change.generation))
      throw new PluginControlsError("Invalid image model", "invalid")
    const keys = generation ? GENERATION : MEDIA_STORAGE
    // Off is written as `false`: removing the key would expose a lower-priority document that enables it.
    const value = generation
      ? typeof change.generation === "string" ? { model: change.generation } : change.generation
      : change.mediaStorage
    const target = context.documents.find(item => item.scope === "global")?.path
    await this.configuration.editConfigDocument(workspaceId, location, "global", document => {
      context.connection.assertCurrent()
      // A new Global `experimental` object would hide a lower-priority one from every whole-object reader.
      if (target && maskedBy(context.entries, target, readNativeSetting(document, ["experimental"]) !== undefined))
        throw new PluginControlsError("Saving would hide inherited experimental OpenCode settings", "conflict")
      return editNativeSetting(document, keys, value)
    })
    context.connection.assertCurrent()
  }
}
