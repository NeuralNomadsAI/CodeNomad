import { MissionControlError } from "./control-error"

export interface MissionRecoveryObservation {
  // All reads must be authoritative and complete. An absent read is not idle.
  active: boolean | undefined
  inboxCount?: number
  pendingForms?: number
  pendingPermissions?: number
  runningShells?: number
  runningChildren?: number
}

export function assertMissionRecoveryReady(observation: MissionRecoveryObservation): void {
  const counts = [observation.inboxCount, observation.pendingForms, observation.pendingPermissions,
    observation.runningShells, observation.runningChildren]
  if (observation.active === undefined || counts.some(count => count === undefined || !Number.isSafeInteger(count) || count < 0)) {
    throw new MissionControlError("Native activity is unknown; recovery was not admitted", "recovery-unknown")
  }
  if (observation.active || counts.some(count => count! > 0)) {
    throw new MissionControlError("Actor has native work or an unresolved wait; use its conversation", "recovery-busy")
  }
}
