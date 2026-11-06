import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { nativePluginBuild } from "./native-plugin-build.mjs"

await build({
  ...nativePluginBuild,
  banner: { js: '// CodeNomad plugin IDs: ["codenomad.memory"]' },
  entryPoints: [fileURLToPath(new URL("../src/opencode/memory/desktop-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/memory/plugin.mjs", import.meta.url)),
})
