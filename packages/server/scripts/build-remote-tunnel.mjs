import { build } from "esbuild"
import { fileURLToPath } from "node:url"

await build({
  entryPoints: [fileURLToPath(new URL("../src/remote-control/tunnel-runtime.ts", import.meta.url))],
  // Replaces tsc's re-export with the OpenTunnel SDK and its Effect copy.
  outfile: fileURLToPath(new URL("../dist/remote-control/tunnel-runtime.js", import.meta.url)),
  allowOverwrite: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
})
