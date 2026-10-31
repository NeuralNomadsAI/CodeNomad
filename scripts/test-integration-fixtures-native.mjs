// OpenCode integration test fixtures against a real isolated daemon (dev-docs/OPENCODE_INTEGRATIONS.md, Test
// fixtures): the loopback fake registry installs the fake integration package, its native RPC contract answers
// within the zod contract, a marker-mismatch package reports another ID, and the reference Python discovery
// client advertises a fake host through the fixture's own registration. No host secret reaches an RPC output or
// the daemon log, and every audited Python access stays inside the fixture and reaches only the fixture daemon.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS, packFakeIntegration, startFakeHost } from "./fixtures/fake-integration/index.mjs"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { withProductRuntime, writeFixtureServiceRegistration } from "./native-product-fixture.mjs"
import { integrationMarkerSchema, readIntegrationRpcOutput } from "../packages/server/src/opencode/integrations/contract.ts"

const PYTHON_HOST = fileURLToPath(new URL("./fixtures/fake-integration/python-host.py", import.meta.url))
const python = ["python3", "python"].find(command => spawnSync(command, ["-I", "-c", "import sys; assert sys.version_info >= (3, 8)"], { windowsHide: true }).status === 0)
assert(python || !process.env.CI, "CI provides Python 3 for the discovery isolation check")

const registry = await startFakeNpmRegistry()
const host = await startFakeHost({ leaky: true })
const secrets = { port: host.port }
let fixtureRoot
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    fixtureRoot = root
    const fixture = await packFakeIntegration(root)
    const drift = await packFakeIntegration(root, { id: "drift", markerMismatch: true })
    for (const pack of [fixture, drift]) {
      assert.equal(integrationMarkerSchema.safeParse(pack.marker).success, true, `${pack.name} carries a conforming marker`)
      registry.publish(pack.name, pack.version, pack.tarball)
    }
    await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ plugins: [`${fixture.name}@${fixture.version}`, `${drift.name}@${drift.version}`] }))
    return {}
  }, async ({ client, root, env, connection }) => {
    const call = async (rpcID, method, input = {}, directory = root) => {
      const { output } = await client.rpc.call({ rpcID, method, input, location: { directory } })
      assert(readIntegrationRpcOutput(`${method}.output`, output).ok, `${rpcID}.${method} answers within the contract: ${JSON.stringify(output)}`)
      assertNoSentinels(output, secrets, `${rpcID}.${method}`)
      return output
    }
    let status
    for (const deadline = Date.now() + 90_000; !status; await delay(250)) {
      status = await call("neuralnomads.fixture", "status").catch(error => { if (Date.now() > deadline) throw error })
    }
    assert.deepEqual(status.integration, { id: "fixture", version: "0.1.0", family: "native", spec: 0 })
    assert.deepEqual(status.host, { state: "absent", expectedRange: "^0.1.0", action: "install" })
    assert.equal(status.connection.state, "none")
    assert(registry.requested.some(url => url === "/@neuralnomads/opencode-fixture"), "The install read the loopback registry")
    assert.equal((await fetch(`${registry.url}/@neuralnomads/opencode-unknown`)).status, 404, "Unknown names answer 404")
    const drift = await call("neuralnomads.drift", "status")
    assert.equal(drift.integration.id, "drift-other", "The marker-mismatch package reports another integration ID")

    if (python) {
      const info = await (await fetch(`${connection.endpoint.url}/api/info`, { headers: {
        authorization: `Basic ${Buffer.from(`opencode:${connection.endpoint.auth.password}`).toString("base64")}` } })).json()
      await writeFixtureServiceRegistration(env, { url: connection.endpoint.url, pid: info.pid, version: info.version, password: connection.endpoint.auth.password })
      const daemon = new URL(connection.endpoint.url)
      // Asynchronous: the fake host answering the plugin's hello lives in this process.
      const runHost = async action => {
        const result = await runPython(python, PYTHON_HOST, { env, cwd: root,
          input: JSON.stringify({ action, rpc_id: "neuralnomads.fixture", offer: host.advertiseInput(), config_dir: env.OPENCODE_CONFIG_DIR }) })
        assert.equal(result.status, 0, result.stderr)
        for (const secret of [FAKE_INTEGRATION_SENTINELS.token, connection.endpoint.auth.password])
          assert(!(result.stdout + result.stderr).includes(secret), "The Python client prints neither the host token nor the daemon password")
        const report = JSON.parse(result.stdout)
        assert.deepEqual(report.services, [connection.endpoint.url], "Discovery finds the fixture daemon only")
        for (const access of report.accesses) {
          if (access.kind === "forbidden") assert.fail(`Python escapes the audit hook through ${access.event}`)
          else if (access.kind === "connect") assert.match(access.address, new RegExp(`^127\\.0\\.0\\.1:${daemon.port}$`), "Python reaches the fixture daemon only")
          else if (access.kind === "resolve") assert.equal(access.address, "127.0.0.1", "Python resolves the fixture daemon only")
          else assert(!path.relative(root, access.path).startsWith("..") && !path.isAbsolute(path.relative(root, access.path)),
            `Python ${access.event ?? access.kind}s inside the fixture only: ${access.path}`)
        }
        assert(report.accesses.some(access => access.kind === "list" && path.resolve(access.path) === path.join(env.XDG_STATE_HOME, "opencode")),
          "Discovery reads the fixture's XDG_STATE_HOME")
        assert.equal(report.candidates[0], path.join(env.XDG_CONFIG_HOME, "opencode"), "The conventional Location is the fixture's XDG_CONFIG_HOME")
        return report.results
      }
      assert.deepEqual(await runHost("advertise"), [{ service: "service.json", outcome: "accepted" }])
      const { offers } = await call("neuralnomads.fixture", "hosts")
      assert.equal(offers.length, 1)
      assert.deepEqual(Object.keys(offers[0]).sort(), ["label", "offerID", "protocol"], "Display fields that mention a secret are dropped")
      assert.deepEqual(await call("neuralnomads.fixture", "attachHost", { offerID: offers[0].offerID, sessionID: "ses_fixture" }), { outcome: "attached" })
      status = await call("neuralnomads.fixture", "status")
      assert.equal(status.host.state, "ok")
      assert.deepEqual(status.connection, { state: "attached", offers: 1, attachedSessions: 1 })
      assert.deepEqual(await call("neuralnomads.fixture", "detachHost", { sessionID: "ses_fixture" }), { outcome: "detached" })
      assert.deepEqual(await runHost("withdraw"), [{ service: "service.json", outcome: "withdrawn" }])
      assert.deepEqual(await call("neuralnomads.fixture", "hosts"), { offers: [] })
    } else console.log("SKIP Python discovery isolation: no Python 3 on PATH")
  }, { registry: registry.url })
  const log = await readFile(path.join(fixtureRoot, "daemon.log"), "utf8")
  for (const [name, secret] of Object.entries(FAKE_INTEGRATION_SENTINELS)) assert(!log.includes(secret), `The daemon log carries no ${name}`)
  console.log(`PASS fake registry install, native RPC contract, marker mismatch${python ? ", Python discovery isolation and advertise/attach/withdraw" : ""}, no secret in outputs or log`)
} finally {
  await host.close()
  await registry.close()
}

function runPython(command, script, { env, cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-I", "-B", script], { env, cwd, windowsHide: true })
    let stdout = "", stderr = ""
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
    child.once("error", reject)
    child.once("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.end(input)
  })
}
