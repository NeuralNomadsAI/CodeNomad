import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import type { OpenCodeClient } from "@opencode/client"

/** Internal construction dependency, never parsed from bridge/HTTP input.
 * prepare rereads native reservations and physical claims; current is the fresh
 * synchronous protected-host/native capability fence at actual native effects. */
export interface MissionAuthorityCheckpoint {
  prepare(): Promise<void>
  current(): true
}
export async function prepareMissionAuthority(checkpoint?: MissionAuthorityCheckpoint): Promise<void> {
  if (!checkpoint) return
  await checkpoint.prepare()
  assertMissionAuthorityCurrent(checkpoint)
}
export function assertMissionAuthorityCurrent(checkpoint?: MissionAuthorityCheckpoint): void {
  if (checkpoint) assertSynchronousAuthorityGuard(() => checkpoint.current(), "policy-unqualified")
}

/** The existing advisory Git probe awaits before its instruction write. Fence
 * that write too, without changing the shared helper or swallowing authority as
 * permission. The route still treats probe failures as advisory and rechecks
 * full authority before the actual mission send. */
export function missionInstructionClient(client: OpenCodeClient, checkpoint?: MissionAuthorityCheckpoint): OpenCodeClient {
  if (!checkpoint) return client
  const entry = client.session.instructions.entry
  return { ...client, session: { ...client.session, instructions: { ...client.session.instructions, entry: { ...entry,
    put: (input, options) => { assertMissionAuthorityCurrent(checkpoint); return entry.put(input, options) },
    remove: (input, options) => { assertMissionAuthorityCurrent(checkpoint); return entry.remove(input, options) },
  } } } }
}
