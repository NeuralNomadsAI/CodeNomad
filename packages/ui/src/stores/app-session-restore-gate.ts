import { createSignal } from "solid-js"

const [appSessionRestoreGateActive, setAppSessionRestoreGateActive] = createSignal(true)

function releaseAppSessionRestoreGate(): void {
  setAppSessionRestoreGateActive(false)
}

export { appSessionRestoreGateActive, releaseAppSessionRestoreGate }
