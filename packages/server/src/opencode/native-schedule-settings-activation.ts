import { createHash } from "node:crypto"
import type { PluginControlLocation, PluginControlScope } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readRuntimeContract } from "./compatibility/negotiate"
import { encodePluginControlOriginal } from "./plugin-control-document"
import { readNativeSetting } from "./native-setting-document"
import { editMissionExperimental, effectiveMissionExperimental, inheritedMissionExperimental,
  nativeExperimentalTargetPosition, nativeSettingExpectation, readMissionExperimental } from "./native-experimental-settings"
import { nativeScheduleCapability } from "./native-schedule-capability"
import { PluginControlsError, type NativeConfigDocuments, type NativeConfigEdit, type PluginControls } from "./plugin-controls"

export type NativeScheduleActivationTarget = { scope: PluginControlScope; path: string; expectation: string; resultDigest: string }
export type NativeScheduleActivationPlan = { authority: string; targets: NativeScheduleActivationTarget[] }
export type NativeScheduleActivationIntent = { authority: string; targets: Array<NativeScheduleActivationTarget & {
  attempted: boolean; acknowledged: boolean }> }
export interface NativeScheduleActivationJournal {
  prepared(plan: NativeScheduleActivationPlan): Promise<void>
  attempting(scope: PluginControlScope, resultDigest: string): Promise<void>
  acknowledged(scope: PluginControlScope, resultDigest: string): Promise<void>
  ready(origin: string | null): Promise<void>
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const digestPattern = /^[a-f0-9]{64}$/

/** Plan only from acquired native discovery. Upper imposed blocks cannot be bypassed. */
export function planNativeScheduleActivation(view: NativeConfigDocuments): NativeConfigEdit[] {
  const global = view.documents.find(item => item.scope === "global")
  const project = view.documents.find(item => item.scope === "project")
  if (!global) throw new PluginControlsError("Global OpenCode configuration is unavailable", "unavailable")
  const local = project && readMissionExperimental(project.document)
  if (local?.schedules === false) throw new PluginControlsError("Project schedules are explicitly disabled", "forbidden")
  const effective = effectiveMissionExperimental(view.entries)
  const target = project ?? global
  const position = nativeExperimentalTargetPosition(view.entries, target.path, view.location.directory)
  const imposed = view.entries.slice(position.after).some(entry => entry.type === "document" && entry.info.experimental !== undefined)
  if (imposed && effective.schedules !== true)
    throw new PluginControlsError("A higher-priority OpenCode configuration prevents schedule activation", "forbidden")
  const edits: NativeConfigEdit[] = []
  const add = (item: typeof global, scope: PluginControlScope) => {
    const updated = editMissionExperimental(item.document, "schedules", true,
      inheritedMissionExperimental(view.entries, item.path, view.location.directory), scope)
    edits.push({ scope, path: item.path, expectation: nativeSettingExpectation(item.document), updated })
  }
  if (readMissionExperimental(global.document).schedules !== true) add(global, "global")
  const block = project && readNativeSetting(project.document, ["experimental"])
  if (project && !imposed && local?.schedules !== true && (block !== undefined || effective.origin !== null && effective.origin !== global.path))
    add(project, "project")
  return edits
}

/** Authenticated Play preparation owns the durable journal callbacks. This executor
 * performs only configuration effects; readiness is acknowledged after native readback. */
export class NativeScheduleSettingsActivation {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments" | "editConfigDocuments">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection" | "getServiceWslDistro">) {}

  private authority(workspaceID: string, view: NativeConfigDocuments) {
    return hash(JSON.stringify([this.manager.getServiceWslDistro(workspaceID) ?? "host", view.location.directory,
      view.documents.map(item => [item.scope, item.path, item.document.writePath])]))
  }
  private async context(workspaceID: string, location: PluginControlLocation) {
    const connection = await this.manager.getSharedServiceConnection(workspaceID)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    const view = await this.documents.readConfigDocuments(workspaceID, location, undefined, true)
    connection.assertCurrent()
    const contract = await readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    if (!nativeScheduleCapability(contract).available) throw new PluginControlsError("Native schedule API is unavailable", "unavailable")
    return { view, connection }
  }
  async prepare(workspaceID: string, location: PluginControlLocation): Promise<NativeScheduleActivationPlan> {
    const { view } = await this.context(workspaceID, location)
    return { authority: this.authority(workspaceID, view), targets: planNativeScheduleActivation(view).map(item => ({
      scope: item.scope, path: item.path, expectation: item.expectation, resultDigest: hash(item.updated),
    })) }
  }
  async apply(workspaceID: string, location: PluginControlLocation, intent: NativeScheduleActivationIntent,
    journal: NativeScheduleActivationJournal): Promise<void> {
    if (!digestPattern.test(intent.authority) || intent.targets.length > 2 || new Set(intent.targets.map(item => item.scope)).size !== intent.targets.length
      || intent.targets.some(item => !["global", "project"].includes(item.scope) || !digestPattern.test(item.expectation)
        || !digestPattern.test(item.resultDigest) || typeof item.attempted !== "boolean" || typeof item.acknowledged !== "boolean"))
      throw new PluginControlsError("Invalid native schedule activation intent", "invalid")
    const { connection } = await this.context(workspaceID, location)
    const acknowledged: NativeScheduleActivationTarget[] = []
    await this.documents.editConfigDocuments(workspaceID, location, view => {
      connection.assertCurrent()
      if (this.authority(workspaceID, view) !== intent.authority)
        throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
      // Recheck OFF and imposed layers before any preparation/rename, even on replay.
      const required = planNativeScheduleActivation(view)
      if (required.some(edit => !intent.targets.some(target => target.scope === edit.scope && target.path === edit.path)))
        throw new PluginControlsError("OpenCode activation targets changed; refresh before saving", "conflict")
      return intent.targets.flatMap(target => {
        const actual = view.documents.find(item => item.scope === target.scope && item.path === target.path)
        if (!actual) throw new PluginControlsError("OpenCode configuration target changed", "conflict")
        if (hash(encodePluginControlOriginal(actual.document)) === target.resultDigest) {
          if (!target.attempted)
            throw new PluginControlsError("OpenCode configuration changed before this activation attempt", "conflict")
          acknowledged.push(target)
          return []
        }
        if (target.attempted || target.acknowledged)
          throw new PluginControlsError("Native schedule configuration effect is uncertain", "conflict")
        if (nativeSettingExpectation(actual.document) !== target.expectation)
          throw new PluginControlsError("OpenCode configuration changed; activation remains paused", "conflict")
        const updated = editMissionExperimental(actual.document, "schedules", true,
          inheritedMissionExperimental(view.entries, actual.path, view.location.directory), target.scope)
        if (hash(updated) !== target.resultDigest)
          throw new PluginControlsError("OpenCode configuration inheritance changed", "conflict")
        return [{ scope: target.scope, path: target.path, expectation: target.expectation, updated }]
      })
    }, {
      beforeWrite: async () => {
        connection.assertCurrent()
        await journal.prepared({ authority: intent.authority, targets: intent.targets.map(({ attempted: _attempted, acknowledged: _ack, ...target }) => target) })
        for (const item of acknowledged) await journal.acknowledged(item.scope, item.resultDigest)
      },
      beforeCommit: async edit => {
        connection.assertCurrent()
        await journal.attempting(edit.scope, hash(edit.updated))
      },
      afterWrite: async edit => {
        connection.assertCurrent()
        const fresh = await this.documents.readConfigDocuments(workspaceID, location, undefined, true)
        connection.assertCurrent()
        const target = fresh.documents.find(item => item.scope === edit.scope && item.path === edit.path)
        if (!target || hash(encodePluginControlOriginal(target.document)) !== hash(edit.updated))
          throw new PluginControlsError("Native schedule configuration acknowledgement is unknown", "conflict")
        await journal.acknowledged(edit.scope, hash(edit.updated))
      },
    })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new PluginControlsError("Native schedule configuration acknowledgement timed out", "unavailable"))
    }, 10_000) })
    const poll = async () => {
      while (true) {
        const view = await this.documents.readConfigDocuments(workspaceID, location, undefined, true)
        connection.assertCurrent(); controller.signal.throwIfAborted()
        if (this.authority(workspaceID, view) !== intent.authority) throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
        planNativeScheduleActivation(view)
        const global = view.documents.find(item => item.scope === "global")!
        const nativeGlobal = [...view.entries].reverse().find(entry => entry.type === "document" && entry.path === global.path && entry.info.experimental !== undefined)
        const effective = effectiveMissionExperimental(view.entries)
        if (nativeGlobal?.type === "document" && nativeGlobal.info.experimental?.schedules === true && effective.schedules === true) return effective.origin
        await new Promise(resolve => setTimeout(resolve, 100))
        controller.signal.throwIfAborted()
      }
    }
    try {
      const origin = await Promise.race([poll(), expired])
      connection.assertCurrent()
      await journal.ready(origin)
    } finally { clearTimeout(timer); controller.abort() }
  }
}
