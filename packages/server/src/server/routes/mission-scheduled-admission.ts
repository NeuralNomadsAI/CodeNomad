import path from "node:path"
import { realpath } from "node:fs/promises"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import { physical } from "../../missions/physical-path"
import { resolveStandingProfileSource } from "../../missions/host-authority/profile-source"
import type { prepareMissionMapMutation } from "./mission-map-mutation"
import type { RecurrenceHoldOwner } from "./mission-recurrence-holds"

export type ScheduledMissionSettings = Pick<SettingsService, "getProfileScope"> &
  Partial<Pick<SettingsService, "configYamlPathForAuthority">>
export type ScheduledMissionManager = Parameters<typeof prepareMissionMapMutation>[0]["manager"] &
  Pick<WorkspaceManager, "getServiceWslDistro"> & Partial<Pick<WorkspaceManager, "getServicePathStyle">>
type Owned = Awaited<ReturnType<typeof prepareMissionMapMutation>>

/** Human and agent creation share the same physical/profile source admission.
 * The caller retains its own authenticated principal and request hold. */
export async function scheduledMissionProfileSource(input: {
  manager: ScheduledMissionManager; settings: ScheduledMissionSettings; workspaceID: string
  owned: Pick<Owned, "location" | "refresh">; owner: RecurrenceHoldOwner
  scope: NonNullable<ReturnType<SettingsService["getProfileScope"]>>
  yaml: string; executionHost: string; check(): void
}) {
  const { manager, settings, workspaceID, owned, owner, scope, yaml, executionHost, check } = input
  if (!manager.getServicePathStyle) throw new Error("Mission schedule host paths unavailable")
  return resolveStandingProfileSource({ settings: {
    getProfileScope: () => settings.getProfileScope(), configYamlPathForAuthority: () => settings.configYamlPathForAuthority!(),
  }, descriptor: { scope, physicalProfile: physical(await realpath(path.dirname(yaml))), executionHost },
  binding: { profileID: scope.key, executionHost, projectID: owner.projectID, projectCanonical: owner.projectCanonical,
    roots: [{ mode: "directory-only", directory: owned.location.directory }] },
  manager: manager as WorkspaceManager, workspaceID,
  roots: { assertRoots: async () => { await owned.refresh(); check() } }, assertCurrent: () => { check(); return true } })
}
