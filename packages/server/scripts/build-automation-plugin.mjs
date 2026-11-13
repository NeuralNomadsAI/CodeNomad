import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { nativePluginBuild } from "./native-plugin-build.mjs"

await build({
  ...nativePluginBuild,
  banner: { js: '// CodeNomad plugin IDs: ["codenomad.automation"]' },
  entryPoints: [fileURLToPath(new URL("../src/opencode/automation/desktop-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/automation/plugin.mjs", import.meta.url)),
})
