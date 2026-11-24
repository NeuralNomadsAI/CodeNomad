import type { NativeMissionAuthority, AuthorityEffectIntent } from "./authority-core"
import type { AuthorityBinding, AuthorityRoot } from "./authority-protocol"
import type { AuthorityGrant } from "./authority-store"

export type MissionAuthorityAdmission = AuthorityBinding & { epoch: number; root: AuthorityRoot }

/** Host-protected grant reader, connection/ownership/send/worktree gate are
 * mandatory adapters. Native storage is a mirror, not an alternative host grant.
 * prepare may apply freshly constructed environment; it must not prompt/send. */
export async function admitWithMissionAuthority<Prepared, Result>(input: {
  authority: NativeMissionAuthority
  binding: MissionAuthorityAdmission
  signal: AbortSignal
  assertHostGrant(grant: AuthorityGrant): Promise<void>
  withHostGate(operation: () => Promise<Result>): Promise<Result>
  prepare(): Promise<Prepared>
  send(prepared: Prepared): Promise<Result>
}): Promise<Result> {
  return input.withHostGate(async () => {
    input.signal.throwIfAborted()
    await input.assertHostGrant(await input.authority.assertAdmission(input.binding))
    const prepared = await input.prepare()
    input.signal.throwIfAborted()
    await input.assertHostGrant(await input.authority.assertAdmission(input.binding))
    input.signal.throwIfAborted()
    return input.send(prepared)
  })
}

/** Pause/Stop/start effects need their own published signed reservation, not an
 * ordinary send grant. The effect adapter must call this before async preparation
 * AND immediately before each native control/send; no arbitrary prompt surface. */
export async function assertMissionControlReservation(authority: NativeMissionAuthority, intent: AuthorityEffectIntent): Promise<void> {
  await authority.assertEffectReservation(intent)
}
