import { build } from "esbuild"
import { fileURLToPath } from "node:url"

await build({
  entryPoints: [fileURLToPath(new URL("../src/opencode/missions/managed-owner-plugin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/plugins/missions/plugin.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
})
