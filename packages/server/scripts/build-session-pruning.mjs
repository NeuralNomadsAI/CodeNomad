import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { nativePluginBuild } from "./native-plugin-build.mjs"

await build({
  ...nativePluginBuild,
  entryPoints: [fileURLToPath(new URL("../src/opencode/session-pruning/desktop-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/session-pruning/plugin.mjs", import.meta.url)),
  // Application dependencies are bundled; OpenCode supplies its native Effect/SDK.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
})
