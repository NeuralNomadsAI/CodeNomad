import type { Plugin } from "@opencode/plugin"
import { followPresence } from "../desktop-plugin-presence"
import { setupMissionsPlugin } from "../missions-plugin"
import { sendMissionInput } from "../automation-plugin"

export function desktopPlugin(presenceDirectory: string | readonly string[]): Plugin.Plugin {
  return {
    id: "codenomad.missions",
    setup: ctx => followPresence(presenceDirectory, () => setupMissionsPlugin(ctx, {
      prompt: (coordinatorID, input) => sendMissionInput(coordinatorID, "prompt", input),
      synthetic: (coordinatorID, input) => sendMissionInput(coordinatorID, "synthetic", input),
    })),
  }
}
