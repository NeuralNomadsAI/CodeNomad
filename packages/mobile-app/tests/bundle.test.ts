import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "vite"

// Inspect the real Rollup module graph, not minified symbol names. Seroval and
// Solid's server entry points are installed for SSR tooling but must never enter
// the untrusted-input-facing bundled launcher (including dynamic locale chunks).
function assertClientOnly(ids: Iterable<string>) {
  for (const id of ids) {
    const path = id.replaceAll("\\", "/")
    assert.doesNotMatch(path, /\/node_modules\/seroval(?:-plugins)?\//, id)
    assert.doesNotMatch(path, /\/solid-js\/(?:web\/|store\/)?dist\/server(?:\.[^/]*)?\.js/, id)
  }
}

test("bundle guard rejects Seroval deserialization and Solid SSR module paths", () => {
  for (const id of [
    "/node_modules/seroval/dist/esm/production/index.mjs",
    "C:\\repo\\node_modules\\seroval\\dist\\cjs\\production\\index.cjs",
    "/node_modules/seroval-plugins/web/index.js",
    "/node_modules/solid-js/dist/server.js",
    "/node_modules/solid-js/web/dist/server.js",
  ]) assert.throws(() => assertClientOnly([id]))
  assertClientOnly(["/node_modules/solid-js/dist/solid.js", "/node_modules/solid-js/web/dist/web.js"])
})

test("real launcher bundle and every locale exclude Seroval/SSR/deserialization modules", async () => {
  const modules = new Set<string>()
  const scripts: string[] = []
  await build({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "error",
    build: { write: false },
    plugins: [{
      name: "verify-launcher-client-only-graph",
      generateBundle(_, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue
          Object.keys(output.modules).forEach((id) => modules.add(id))
          scripts.push(output.code)
        }
      },
    }],
  })
  assert(modules.size > 10, "guard must inspect a nonempty real bundle")
  assert([...modules].some((id) => id.replaceAll("\\", "/").includes("/solid-js/web/dist/web.js")))
  assert.equal([...modules].filter((id) => /\/messages\/[^/]+\/remoteAccess\.ts$/.test(id.replaceAll("\\", "/"))).length, 10)
  assertClientOnly(modules)
  assert.doesNotMatch(scripts.join("\n"), /seroval|\bfromJSON\s*\(|\bdeserialize\s*\(/)
})
