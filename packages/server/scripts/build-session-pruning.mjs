import { build } from "esbuild"
import { fileURLToPath } from "node:url"

await build({
  entryPoints: [fileURLToPath(new URL("../src/opencode/session-pruning/desktop-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/session-pruning/plugin.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Dependencies are bundled at build time; installing CodeNomad needs no npm step.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
})
