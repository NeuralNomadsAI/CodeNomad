import { installRemoteControlTransport } from "./lib/remote-control/tunnel"

void (async () => {
  await installRemoteControlTransport()
  await import("./main")
})()
