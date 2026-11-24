import "./session"
import { sdkManager } from "../../../src/lib/sdk-manager"

// Reuse the SessionView fixture and its native dispatcher; only historical HTTP
// completion is held so a real wheel can act while a page request is pending.
const client = (sdkManager as any).clients.get("browser-instance:/workspaces/browser-instance/instance")
const list = client.message.list
let delay = false, pending = false, release: (() => void) | undefined
client.message.list = async (input: any) => {
  if (delay) {
    delay = false
    pending = true
    await new Promise<void>(resolve => { release = resolve })
    pending = false
  }
  return list(input)
}
Object.assign((window as any).fixture, {
  delayNextHistory: () => { delay = true },
  historyPending: () => pending,
  releaseHistory: () => release?.(),
})
