import { createSignal } from "solid-js"
import type { RestorableSessionState } from "./client-state-codec"

const [appSessionRestoreGateActive, setAppSessionRestoreGateActive] = createSignal(true)

function releaseAppSessionRestoreGate(): void {
  setAppSessionRestoreGateActive(false)
}

function shouldShowAppRestoreLoading(snapshot: RestorableSessionState | null, restoreActive = appSessionRestoreGateActive()): boolean {
  return restoreActive && Boolean(snapshot?.tabs.length) && snapshot?.homeActive !== true
}

function shouldShowAppHomeOverlay(requested: boolean, tabCount: number): boolean {
  return requested && tabCount > 0
}

export { appSessionRestoreGateActive, releaseAppSessionRestoreGate, shouldShowAppHomeOverlay, shouldShowAppRestoreLoading }
