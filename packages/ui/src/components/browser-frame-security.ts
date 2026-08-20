import type { RuntimeEnvironment } from "../lib/runtime-env"

const NATIVE_FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"

export function getBrowserFramePolicy(environment: Pick<RuntimeEnvironment, "host" | "windowContext">) {
  const sandboxed = environment.windowContext === "local" && (environment.host === "electron" || environment.host === "tauri")
  return {
    sandbox: sandboxed ? NATIVE_FRAME_SANDBOX : undefined,
    canInspectDom: !sandboxed,
  }
}
