import { createHash } from "node:crypto"
import type { PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readRuntimeContract } from "./compatibility/negotiate"
import { configuredMissionAutomation, readMissionExperimental } from "./native-experimental-settings"
import { readNativeScheduleFlag, nativeScheduleFlagOrigin, type NativeScheduleFlag } from "./native-schedule-flag"
import { nativeScheduleCapability } from "./native-schedule-capability"
import { PluginControlsError, type NativeConfigDocuments, type PluginControls } from "./plugin-controls"
import { readNativeSetting } from "./native-setting-document"
import { INLINE_CONFIG_SOURCE, REMOTE_CONFIG_SOURCE } from "./missions/native-automations-setting"

export type NativeScheduleActivationPlan = { authority: string }
export interface NativeScheduleActivationJournal {
  prepared(plan: NativeScheduleActivationPlan): Promise<void>
  ready(origin: string | null): Promise<void>
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const digestPattern = /^[a-f0-9]{64}$/

export type NativeScheduleActivationRefusal = { reason: "explicit-off";
  provenance: NativeScheduleFlag["provenance"]; layer: "environment" | "global" | "project" | "inherited" | "imposed"; path?: string }
export class NativeScheduleActivationRefused extends PluginControlsError {
  readonly code = "schedule-activation-refused"
  constructor(readonly refusal: NativeScheduleActivationRefusal) {
    super("Native schedule activation refused by configuration", "forbidden")
  }
}

/** Automations are on unless a source turns them off. Any explicit OFF refuses, also one hidden
 * under a higher ON; nothing here writes configuration. */
export function assertNativeScheduleActivation(view: NativeConfigDocuments, flag: NativeScheduleFlag): void {
  const refuse = (path: string | undefined, provenance: NativeScheduleFlag["provenance"] = "experimental-block"): never => {
    const scope = view.documents.find(item => item.path === path)?.scope
    throw new NativeScheduleActivationRefused({ reason: "explicit-off", provenance,
      layer: scope ?? (path ? "inherited" : "imposed"), ...(path ? { path } : {}) })
  }
  // Inspect every discovered layer; the owned raw documents also fence native watcher lag.
  for (const entry of view.entries) if (entry.type === "document") {
    if ((entry.info as { automations?: unknown }).automations === false) refuse(entry.path, "automations-setting")
    if (configuredMissionAutomation(entry.info.experimental ?? {}) === false) refuse(entry.path)
  }
  for (const item of view.documents) {
    if (readNativeSetting(item.document, ["automations"]) === false) refuse(item.path, "automations-setting")
    if (configuredMissionAutomation(readMissionExperimental(item.document)) === false) refuse(item.path)
  }
  if (!flag.enabled && flag.provenance === "environment")
    throw new NativeScheduleActivationRefused({ reason: "explicit-off", provenance: "environment", layer: "environment" })
  // Inline and remote daemon configuration are no openable document.
  const source = (path: string) => path === INLINE_CONFIG_SOURCE || path === REMOTE_CONFIG_SOURCE ? undefined : path
  // OFF layers the daemon reads but no entry exposes, such as a block saved for an earlier runtime below a newer ON.
  for (const path of flag.hiddenOff ?? []) refuse(source(path))
  if (!flag.enabled) refuse(flag.path && source(flag.path), flag.provenance)
}

/** Authenticated Play preparation owns the durable journal callbacks. This executor only reads
 * configuration; readiness is acknowledged after the effective native setting reads ON. */
export class NativeScheduleSettingsActivation {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection" | "getServiceWslDistro">) {}

  private authority(workspaceID: string, view: NativeConfigDocuments) {
    return hash(JSON.stringify([this.manager.getServiceWslDistro(workspaceID) ?? "host", view.location.directory,
      view.documents.map(item => [item.scope, item.path, item.document.writePath])]))
  }
  /** The fresh view and effective setting, with every explicit OFF refused. */
  private async admitted(workspaceID: string, location: PluginControlLocation, authority?: string) {
    const connection = await this.manager.getSharedServiceConnection(workspaceID)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    const view = await this.documents.readConfigDocuments(workspaceID, location, undefined, true)
    connection.assertCurrent()
    const contract = await readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    if (!nativeScheduleCapability(contract).available) throw new PluginControlsError("Native schedule API is unavailable", "unavailable")
    const flag = await readNativeScheduleFlag(connection, location)
    if (authority !== undefined && this.authority(workspaceID, view) !== authority)
      throw new PluginControlsError("OpenCode configuration authority changed", "conflict")
    assertNativeScheduleActivation(view, flag)
    return { view, connection, flag }
  }
  async prepare(workspaceID: string, location: PluginControlLocation): Promise<NativeScheduleActivationPlan> {
    const { view } = await this.admitted(workspaceID, location)
    return { authority: this.authority(workspaceID, view) }
  }
  async verify(workspaceID: string, location: PluginControlLocation, authority: string): Promise<void> {
    await this.admitted(workspaceID, location, authority)
  }
  async apply(workspaceID: string, location: PluginControlLocation, plan: NativeScheduleActivationPlan,
    journal: NativeScheduleActivationJournal): Promise<void> {
    if (!digestPattern.test(plan.authority)) throw new PluginControlsError("Invalid native schedule activation intent", "invalid")
    await this.admitted(workspaceID, location, plan.authority)
    await journal.prepared({ authority: plan.authority })
    // The journal write is a native round trip: the setting is read again before readiness.
    const { connection, flag } = await this.admitted(workspaceID, location, plan.authority)
    connection.assertCurrent()
    await journal.ready(nativeScheduleFlagOrigin(flag))
  }
}
