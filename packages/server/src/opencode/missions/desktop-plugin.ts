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
      lifecycle: (coordinatorID, input) => sendMissionInput(coordinatorID, "lifecycle", input),
      cleanup: async (coordinatorID, input) => {
        const result = await sendMissionInput(coordinatorID, "cleanup", input) as { outcome?: unknown }
        if (result?.outcome !== "removed" && result?.outcome !== "retained") throw new Error("Invalid mission cleanup acknowledgement")
        return { outcome: result.outcome }
      },
    })),
  }
}
