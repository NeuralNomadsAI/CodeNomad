import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { nativePluginBuild } from "./native-plugin-build.mjs"

await build({
  ...nativePluginBuild,
  entryPoints: {
    plugin: fileURLToPath(new URL("../src/opencode/missions/managed-owner-plugin.ts", import.meta.url)),
    provider: fileURLToPath(new URL("../src/opencode/missions/native-schedule-carrier-provider.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("../dist/plugins/missions", import.meta.url)),
  outExtension: { ".js": ".mjs" },
})
