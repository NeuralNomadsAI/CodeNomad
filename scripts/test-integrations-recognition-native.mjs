// OpenCode integration recognition against a real isolated daemon (dev-docs/OPENCODE_INTEGRATIONS.md, Recognition):
// the loopback fake registry installs the fake integration (loaded, answering `status`), a marker-mismatch variant
// (non-conforming) and a third one disabled by its exact `-neuralnomads.<id>` rule, which OpenCode does not list. The
// integrations read recognises each by the catalog, calls only the catalog's RPC IDs, and adding a native
// integration to Project is refused before any write. A package absent from the registry fails before exporting its
// plugin ID and is still attributed by its one exact source; installation by catalog ID writes the catalog spec and
// refuses Project, declared and loaded integrations without writing.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { packFakeIntegration } from "./fixtures/fake-integration/index.mjs"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { catalogEntry, catalogOf } from "../packages/server/src/opencode/integrations/catalog-fixture.ts"
import { IntegrationInstaller } from "../packages/server/src/opencode/integrations/install.ts"
import { IntegrationsReader } from "../packages/server/src/opencode/integrations/integrations.ts"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { PluginSources } from "../packages/server/src/opencode/plugin-sources.ts"

const registry = await startFakeNpmRegistry()
const catalog = catalogOf(catalogEntry("fixture"), catalogEntry("drift"), catalogEntry("off"), catalogEntry("absent"), catalogEntry("broken"),
  catalogEntry("later"))
const catalogSource = { read: async () => ({ state: "fresh", fetchedAt: new Date(0).toISOString(), catalog }) }
let configDirectory
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory: directory }) => {
    configDirectory = directory
    const packs = [await packFakeIntegration(root), await packFakeIntegration(root, { id: "drift", markerMismatch: true }), await packFakeIntegration(root, { id: "off" })]
    for (const pack of packs) registry.publish(pack.name, pack.version, pack.tarball)
    await writeFile(path.join(directory, "opencode.jsonc"), JSON.stringify({
      plugins: [...packs.map(pack => `${pack.name}@${pack.version}`), "-neuralnomads.off", "@neuralnomads/opencode-broken@0.1.0"] }))
    return {}
  }, async ({ client, root, connection }) => {
    const location = { directory: root }
    await client.location.get({ location })
    const calls = []
    const recorded = { ...connection, client: { ...connection.client, rpc: { call: (request, options) => {
      calls.push(request.rpcID)
      return connection.client.rpc.call(request, options)
    } } } }
    const workspaceManager = {
      get: () => ({}), getSharedServiceConnection: async () => recorded,
      getServiceDirectoryForPath: async (_id, value) => value === root ? root : undefined,
      ownsLocation: async (_id, candidate) => candidate.directory === root,
      getWorktreeIdentityForPath: async () => "fixture-root", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
    }
    const controls = new PluginControls({ workspaceManager, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } })
    const reader = new IntegrationsReader({ controls, workspaceManager, catalog: catalogSource })
    const states = response => Object.fromEntries(response.integrations.map(item => [item.id, item.state]))
    let response
    for (const deadline = Date.now() + 90_000; ; await delay(250)) {
      response = await reader.read("fixture", location)
      if (states(response).fixture === "ok" && states(response).drift !== "inactive" && states(response).broken === "failed") break
      if (Date.now() > deadline) assert.fail(`Integrations did not load: ${JSON.stringify(states(response))}`)
    }
    assert.deepEqual(states(response), { fixture: "ok", drift: "non-conforming", off: "inactive", absent: "absent", broken: "failed", later: "absent" })
    const off = response.integrations.find(item => item.id === "off")
    assert.equal(off.configured, true, "The disabled integration is recognised by its exact rule")
    assert.deepEqual(off.scopes, ["global"])
    const facts = Object.fromEntries(response.integrations.map(item => [item.id, item.plugin]))
    assert.deepEqual(facts, {
      fixture: { declared: true, runtime: "loaded", runtimeId: "neuralnomads.fixture" },
      drift: { declared: true, runtime: "loaded", runtimeId: "neuralnomads.drift" },
      off: { declared: true }, absent: { declared: false }, broken: { declared: true, runtime: "failed" }, later: { declared: false } })
    assert.equal(response.integrations.some(item => item.ambiguous), false)
    assert.equal(response.integrations.find(item => item.id === "drift").ambiguous, undefined, "a marker mismatch is not ambiguity")
    const failed = (await controls.read("fixture", location)).runtime.find(item => item.source.type === "package"
      && item.source.target === "@neuralnomads/opencode-broken@0.1.0")
    assert.equal(failed?.id, undefined, "A real native failure precedes the exported plugin ID")
    assert.equal(JSON.stringify(response).includes("127.0.0.1"), false, "Registry addresses and native errors stay out of the projection")
    assert.deepEqual(response.integrations.find(item => item.id === "fixture").status.host, { state: "absent", expectedRange: "^0.1.0", action: "install" })
    assert.deepEqual([...new Set(calls)].sort(), ["neuralnomads.drift", "neuralnomads.fixture"], "Only loaded integrations are called, under catalog RPC IDs")

    const before = await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8")
    const sources = new PluginSources({ documents: controls, logger: { info() {} }, catalog: catalogSource })
    await assert.rejects(sources.add("fixture", { location, scope: "project", spec: "@neuralnomads/opencode-absent@0.1.0" }), error => error.code === "global-only")
    await assert.rejects(sources.add("fixture", { location, scope: "global", spec: "@neuralnomads/opencode-fixture@latest" }), error => error.code === "duplicate")
    assert.equal(await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8"), before, "Refused adds write nothing")

    const installer = new IntegrationInstaller({ controls, workspaceManager, catalog: catalogSource, sources })
    for (const [id, scope, code] of [["later", "project", "global-only"], ["fixture", "global", "duplicate"], ["off", "global", "duplicate"], ["broken", "global", "duplicate"]]) {
      await assert.rejects(installer.install("fixture", id, location, scope), error => error.code === code, `${id} ${scope}`)
    }
    assert.equal(await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8"), before, "Refused installs write nothing")
    assert.deepEqual(await installer.install("fixture", "later", location, "global"), { scope: "global", spec: "@neuralnomads/opencode-later@^0.1", reloadPending: true })
    assert.deepEqual(JSON.parse(await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8")).plugins.at(-1), "@neuralnomads/opencode-later@^0.1")
    await assert.rejects(installer.install("fixture", "later", location, "global"), error => error.code === "duplicate", "A written install is a declaration")
  }, { registry: registry.url })
  console.log("PASS integration recognition: loaded, marker mismatch, normalized disabled rule, absent, failed package without ID, plugin facts; Global-only and duplicate adds and installs refused, install by catalog ID written")
} finally {
  await registry.close()
}
