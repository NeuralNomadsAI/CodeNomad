import { Service } from "@opencode/client/service"
import type { ImageGenerationSelection, ImageModelOption, ImageSettingsSnapshot, PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError, type PluginControls } from "./plugin-controls"
import type { PluginControlDocument } from "./plugin-control-document"
import { editNativeSetting, readNativeSetting, removeEmptyNativeObject } from "./native-setting-document"
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

type Entry = { type: string; info?: { experimental?: Record<string, unknown> } }
/** Configuration documents, highest priority first. */
const documents = (entries: readonly unknown[]) =>
  entries.filter((entry): entry is Entry & { type: "document" } => Boolean(entry) && (entry as Entry).type === "document").reverse()

/** Global scope only: a project `experimental` object would hide every inherited experimental setting. */
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

  private async imageModels(context: Awaited<ReturnType<ImageSettings["context"]>>): Promise<ImageModelOption[]> {
    const url = new URL("/api/model", context.connection.endpoint.url)
    url.searchParams.set("location[directory]", context.location.directory)
    url.searchParams.set("types", "image")
    const response = await context.connection.fetch(url, {
      headers: Service.headers(context.connection.endpoint), redirect: "error", signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new PluginControlsError("OpenCode image models are unavailable", "unavailable")
    }
    const body = await response.json() as { data?: unknown }
    context.connection.assertCurrent()
    if (!Array.isArray(body.data)) throw new PluginControlsError("OpenCode image models are unavailable", "unavailable")
    return body.data.flatMap((model: any) => typeof model?.providerID === "string" && typeof model?.id === "string"
      ? [{ ref: `${model.providerID}/${model.id}`, name: typeof model.name === "string" && model.name ? model.name : model.id }] : [])
  }

  async read(workspaceId: string, location: PluginControlLocation): Promise<ImageSettingsSnapshot> {
    const context = await this.context(workspaceId, location)
    const global = context.documents.find(item => item.scope === "global")
    const project = context.documents.find(item => item.scope === "project")
    const settings = documents(context.entries)
    const projectSets = (keys: string[]) => project && readNativeSetting(project.document, keys) !== undefined ? project.path : undefined

    let generation: ImageSettingsSnapshot["generation"] = null
    if (context.capability.generation && global) {
      // OpenCode reads this one field from the last document that sets it.
      const effective = settings.find(entry => entry.info?.experimental?.image_generate !== undefined)
      const projectOverride = projectSets(GENERATION)
      generation = {
        global: imageGenerationSelection(readNativeSetting(global.document, GENERATION)),
        effective: imageGenerationSelection(effective?.info?.experimental?.image_generate),
        ...(projectOverride ? { projectOverride } : {}),
        models: await this.imageModels(context),
      }
    }

    let mediaStorage: ImageSettingsSnapshot["mediaStorage"] = null
    if (context.capability.mediaStorage && global) {
      // OpenCode reads the whole `experimental` object of the last document that has one.
      const latest = settings.find(entry => entry.info?.experimental !== undefined)
      const projectOverride = projectSets(["experimental"])
      mediaStorage = {
        global: readNativeSetting(global.document, MEDIA_STORAGE) === true,
        effective: latest?.info?.experimental?.media_blob === true,
        ...(projectOverride ? { projectOverride } : {}),
      }
    }
    return { location: context.location, generation, mediaStorage }
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
    const value = generation
      ? change.generation === false ? undefined : typeof change.generation === "string" ? { model: change.generation } : true
      : change.mediaStorage ? true : undefined
    await this.configuration.editConfigDocument(workspaceId, location, "global", document => {
      context.connection.assertCurrent()
      const updated = editNativeSetting(document, keys, value)
      if (value !== undefined) return updated
      const remaining: PluginControlDocument = { ...document, text: document.byteOrderMark ? updated.slice(1) : updated }
      return removeEmptyNativeObject(remaining, ["experimental"]) ?? updated
    })
    context.connection.assertCurrent()
  }
}
