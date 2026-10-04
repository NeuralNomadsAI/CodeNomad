import assert from "node:assert/strict"
import { after, test } from "node:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer, type Plugin, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { prepareInterruptionDock } from "./fixtures/interruption-dock-preparation"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const disposedCaches: string[] = []
after(async () => {
  // Recheck after subsequent optimizer work, not just immediately after rm.
  for (const cacheDir of disposedCaches) await assert.rejects(stat(cacheDir), { code: "ENOENT" })
})
const pending = (server: ViteDevServer) => (server as ViteDevServer & { _pendingRequests: Map<unknown, unknown> })._pendingRequests.size
async function setup(fault?: Plugin) {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root, logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, ...(fault ? [fault] : []), solid()], resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  const native = server.close.bind(server)
  shutdown.own(server)
  await server.listen()
  return { server, cache, native }
}
async function closed(server: ViteDevServer, cacheDir: string) {
  const started = performance.now(), close = server.close()
  assert.equal(server.close(), close)
  await Promise.all([close, server.close()])
  assert.ok(performance.now() - started < 10_000, "native cancellation/drain must settle")
  assert.equal(pending(server), 0)
  assert.equal(server.httpServer?.listening, false)
  await assert.rejects(stat(cacheDir), { code: "ENOENT" })
  disposedCaches.push(cacheDir)
}

test("actual Icon compilation failure drains optimized loads and preserves the original failure", { timeout: 45_000 }, async () => {
  let injected = false
  const f = await setup({ name: "actual-icon-failure", enforce: "pre", transform(_code, id) {
    if (!injected && id.replace(/\\/g, "/").endsWith("/lucide-solid/dist/source/Icon.jsx")) {
      injected = true; throw new Error("controlled dependency-error")
    }
  } })
  try { await assert.rejects(prepareInterruptionDock(f.server), /controlled dependency-error/) }
  finally { await closed(f.server, f.cache.cacheDir) }
  assert.equal(injected, true)
})

test("actual partial upload HTML/TSX close preserves a simultaneously live fixture and sentinel", { timeout: 45_000 }, async () => {
  const first = await startDeviceUploadFixture(), second = await startDeviceUploadFixture()
  const sentinel = `${second.server.config.cacheDir}/sibling-sentinel`
  await writeFile(sentinel, "preserve-live-fixture")
  try {
    assert.equal((await fetch(first.url)).status, 200)
    const entry = new URL("/tests/browser/fixtures/device-upload.tsx", first.url)
    assert.equal((await fetch(entry)).status, 200)
    console.log(JSON.stringify({ kind: "partial-upload-close", pendingBefore: pending(first.server) }))
    await closed(first.server, first.server.config.cacheDir)
    assert.equal(await readFile(sentinel, "utf8"), "preserve-live-fixture")
    assert.equal(second.server.httpServer?.listening, true)
    assert.equal((await fetch(second.url)).status, 200)
    assert.equal((await fetch(new URL("/@vite/client", second.url))).status, 200)
  } finally {
    await first.server.close(); await second.server.close()
    disposedCaches.push(second.server.config.cacheDir)
  }
})

for (const mode of ["entry", "timeout"] as const) {
  test(`actual ${mode} preparation failure preserves its error and drains before disposal`, { timeout: 45_000 }, async () => {
    let release: ReturnType<typeof setTimeout> | undefined
    const f = await setup({ name: `actual-${mode}-failure`, enforce: "pre", transform(_code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/tests/browser/fixtures/interruption-dock.tsx")) return null
      if (mode === "entry") throw new Error("controlled entry-error")
      // Deliberately finite compiler gate forces the REAL 30s helper deadline;
      // this is a failure injection, never a delay in fixture preparation.
      return new Promise<null>(resolve => { release = setTimeout(() => resolve(null), 31_000) })
    } })
    try {
      await assert.rejects(prepareInterruptionDock(f.server), mode === "entry" ? /controlled entry-error/ : /preparation exceeded 30000ms/)
    } finally { await closed(f.server, f.cache.cacheDir); clearTimeout(release) }
  })
}

for (const failure of ["close-one", "close-two", "dispose"] as const) {
  test(`${failure} failure retains error identity and never disposes before native acknowledgement`, async () => {
    const cache = await createFixtureCache(), error = new Error(`controlled ${failure}`)
    let disposed = false, pass = 0
    const shutdown = createFixtureShutdown({ cacheDir: cache.cacheDir, async dispose() {
      if (failure === "dispose") throw error
      disposed = true; await cache.dispose()
    } })
    const server = await createServer({ configFile: false, root, cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid()], optimizeDeps: { exclude: ["lucide-solid"] }, server: { hmr: false, watch: null } })
    const native = server.close.bind(server)
    server.close = async () => { pass++; if (failure === (pass === 1 ? "close-one" : "close-two")) throw error; await native() }
    shutdown.own(server)
    try { await assert.rejects(server.close(), value => value === error); assert.equal(disposed, false) }
    finally { await native(); await native(); assert.equal(pending(server), 0); await cache.dispose() }
  })
}
