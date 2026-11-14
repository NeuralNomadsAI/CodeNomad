import { createHash } from "node:crypto"
import type { PluginControlLocation, PluginControlScope } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readRuntimeContract } from "./compatibility/negotiate"
import { encodePluginControlOriginal } from "./plugin-control-document"
import { editMissionExperimental, inheritedMissionExperimental,
  nativeExperimentalTargetPosition, nativeSettingExpectation, readMissionExperimental } from "./native-experimental-settings"
import { readNativeScheduleFlag, nativeScheduleFlagOrigin, type NativeScheduleFlag } from "./native-schedule-flag"
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

export type NativeScheduleActivationRefusal = { reason: "explicit-off" | "masked";
  provenance: NativeScheduleFlag["provenance"]; layer: "environment" | "global" | "project" | "inherited" | "imposed"; path?: string }
export class NativeScheduleActivationRefused extends PluginControlsError {
  readonly code = "schedule-activation-refused"
  constructor(readonly refusal: NativeScheduleActivationRefusal) {
    super("Native schedule activation refused by configuration", "forbidden")
  }
}

/** Plan only from acquired native discovery. Upper imposed blocks cannot be bypassed. */
export function planNativeScheduleActivation(view: NativeConfigDocuments, flag: NativeScheduleFlag): NativeConfigEdit[] {
  const project = view.documents.find(item => item.scope === "project")
  const refuse = (path: string | undefined, reason: NativeScheduleActivationRefusal["reason"] = "explicit-off"): never => {
    const scope = view.documents.find(item => item.path === path)?.scope
    throw new NativeScheduleActivationRefused({ reason, provenance: "experimental-block",
      layer: reason === "masked" ? "imposed" : scope ?? (path ? "inherited" : "imposed"), ...(path ? { path } : {}) })
  }
  // Inspect every discovered layer, including OFF hidden by a higher ON; the
  // owned raw documents also fence native watcher lag before a write.
  for (const entry of view.entries)
    if (entry.type === "document" && entry.info.experimental?.schedules === false) refuse(entry.path)
  for (const item of view.documents)
    if (readMissionExperimental(item.document).schedules === false) refuse(item.path)
  if (!flag.enabled && flag.provenance === "environment")
    throw new NativeScheduleActivationRefused({ reason: "explicit-off", provenance: "environment", layer: "environment" })
  if (flag.enabled) return []
  if (!project) throw new PluginControlsError("Project OpenCode configuration is unavailable", "unavailable")
  const position = nativeExperimentalTargetPosition(view.entries, project.path, view.location.directory)
  const imposed = view.entries.slice(position.after).find(entry => entry.type === "document" && entry.info.experimental !== undefined)
  if (imposed?.type === "document") refuse(imposed.path, "masked")
  const updated = editMissionExperimental(project.document, "schedules", true,
    inheritedMissionExperimental(view.entries, project.path, view.location.directory))
  return [{ scope: "project", path: project.path, expectation: nativeSettingExpectation(project.document), updated }]
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
    const flag = await readNativeScheduleFlag(connection, location)
    return { view, connection, flag }
  }
  async prepare(workspaceID: string, location: PluginControlLocation): Promise<NativeScheduleActivationPlan> {
    const { view, flag } = await this.context(workspaceID, location)
    return { authority: this.authority(workspaceID, view), targets: planNativeScheduleActivation(view, flag).map(item => ({
      scope: item.scope, path: item.path, expectation: item.expectation, resultDigest: hash(item.updated),
    })) }
  }
  async verify(workspaceID: string, location: PluginControlLocation, authority: string): Promise<void> {
    const { view, flag } = await this.context(workspaceID, location)
    if (this.authority(workspaceID, view) !== authority)
      throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
    planNativeScheduleActivation(view, flag)
    if (!flag.enabled) throw new PluginControlsError("Native schedule activation is not effective", "conflict")
  }
  async apply(workspaceID: string, location: PluginControlLocation, intent: NativeScheduleActivationIntent,
    journal: NativeScheduleActivationJournal): Promise<void> {
    if (!digestPattern.test(intent.authority) || intent.targets.length > 2 || new Set(intent.targets.map(item => item.scope)).size !== intent.targets.length
      || intent.targets.some(item => !["global", "project"].includes(item.scope) || !digestPattern.test(item.expectation)
        || !digestPattern.test(item.resultDigest) || typeof item.attempted !== "boolean" || typeof item.acknowledged !== "boolean"))
      throw new PluginControlsError("Invalid native schedule activation intent", "invalid")
    const { connection, flag } = await this.context(workspaceID, location)
    // Two-target persisted intentions keep their exact identity and digests;
    // reconciliation observes effects already attempted and never resumes writes.
    const legacy = intent.targets.some(target => target.scope === "global")
    const acknowledged: NativeScheduleActivationTarget[] = []
    await this.documents.editConfigDocuments(workspaceID, location, view => {
      connection.assertCurrent()
      if (this.authority(workspaceID, view) !== intent.authority)
        throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
      // Recheck OFF and imposed layers before any preparation/rename, even on replay.
      const required = planNativeScheduleActivation(view, flag)
      if (!legacy && required.some(edit => !intent.targets.some(target => target.scope === edit.scope && target.path === edit.path)))
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
        if (legacy)
          throw new PluginControlsError("Original native schedule activation requires observation of its attempted effects", "conflict")
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
        const fresh = await this.context(workspaceID, location)
        connection.assertCurrent()
        if (this.authority(workspaceID, fresh.view) !== intent.authority)
          throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
        const required = planNativeScheduleActivation(fresh.view, fresh.flag)
        if (!required.some(target => target.path === edit.path && target.scope === edit.scope
          && target.expectation === edit.expectation && hash(target.updated) === hash(edit.updated)))
          throw new PluginControlsError("OpenCode configuration changed before activation", "conflict")
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
        const effective = await readNativeScheduleFlag(connection, location)
        controller.signal.throwIfAborted()
        planNativeScheduleActivation(view, effective)
        if (effective.enabled) return nativeScheduleFlagOrigin(view.entries, effective)
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
