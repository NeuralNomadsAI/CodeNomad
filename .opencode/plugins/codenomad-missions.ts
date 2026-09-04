import { Plugin } from "@opencode-ai/plugin"

import { setupMissionsPlugin } from "../../packages/server/src/opencode/missions-plugin.ts"

export default Plugin.define({
  id: "codenomad.missions",
  setup: (context) => setupMissionsPlugin(context as never),
})
