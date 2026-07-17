import { createSignal } from "solid-js"
import type { RestorableSessionState } from "./client-state-codec"

const [appSessionRestoreGateActive, setAppSessionRestoreGateActive] = createSignal(true)

function releaseAppSessionRestoreGate(): void {
  setAppSessionRestoreGateActive(false)
}

function shouldShowEmptyAppHome(snapshot: RestorableSessionState | null, restoreActive = appSessionRestoreGateActive()): boolean {
  return !restoreActive || !snapshot?.tabs.length || snapshot.homeActive === true
}

export { appSessionRestoreGateActive, releaseAppSessionRestoreGate, shouldShowEmptyAppHome }
