import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { nativePluginBuild } from "./native-plugin-build.mjs"

await build({
  ...nativePluginBuild,
  entryPoints: [fileURLToPath(new URL("../src/opencode/missions/managed-owner-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/missions/plugin.mjs", import.meta.url)),
})
