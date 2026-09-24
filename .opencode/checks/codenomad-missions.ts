import { Plugin } from "@opencode/plugin"

import { setupMissionsPlugin } from "../../packages/server/src/opencode/missions-plugin.ts"

Plugin.define({ id: "codenomad.missions", setup: setupMissionsPlugin })
