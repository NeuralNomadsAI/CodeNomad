import type { NativeScheduleSettingsActivation } from "../../opencode/native-schedule-settings-activation"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { missionScheduleActivationRefusal } from "./mission-schedule-activation-refusal"
import type { missionScheduleActivationJournal } from "./mission-schedule-activation-journal"

/** The editor and agent Play share exact activation receipts and explicit-OFF guards. */
export async function prepareMissionScheduleSettings(args: {
  adapter: ReturnType<typeof missionScheduleActivationJournal>
  activation: Pick<NativeScheduleSettingsActivation, "prepare" | "apply" | "verify">
  workspaceID: string; location: { directory: string }; requestID: string; expectedRevision: number
  before?: Awaited<ReturnType<ReturnType<typeof missionScheduleActivationJournal>["read"]>>
  refresh(): Promise<void>; noEffect?(value: boolean): void; isNoEffect?(): boolean
}) {
  const { adapter, activation, workspaceID, location, requestID, expectedRevision } = args
  const before = args.before ?? await adapter.read(), previous = before.scheduleActivation
  const same = previous?.requestID === requestID && previous.expectedRevision === expectedRevision
  args.noEffect?.(!same)
  if (previous?.state === "ready" && (same || before.revision === expectedRevision)) {
    await activation.verify(workspaceID, location, previous.authority)
    await args.refresh()
    const after = await adapter.read()
    if (after.revision !== before.revision) throw new PluginControlsError("Mission activation changed during verification", "conflict")
    return after
  }
  if (!same && (before.revision !== expectedRevision || previous?.state === "prepared"))
    throw new PluginControlsError("Original Mission activation remains unresolved", "conflict")
  let noEffect = !same
  try {
    const plan = same ? { authority: previous!.authority } : await activation.prepare(workspaceID, location)
    await args.refresh()
    noEffect = false
    await activation.apply(workspaceID, location, plan, adapter.journal)
    return await adapter.read()
  } catch (error) {
    if ((args.isNoEffect?.() ?? noEffect) && missionScheduleActivationRefusal(error)) throw error
    await adapter.failed(error instanceof PluginControlsError ? `configuration-${error.kind}` : "configuration-unconfirmed").catch(() => undefined)
    throw error
  }
}
