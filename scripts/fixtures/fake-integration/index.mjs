// Test-side helpers of the fake OpenCode integration (dev-docs/OPENCODE_INTEGRATIONS.md, Test fixtures):
// a loopback fake host with sentinel secrets, a leak scanner, and the installable plugin package.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { capabilityHash, FAKE_INTEGRATION_PACKAGE, FAKE_INTEGRATION_VERSION, fakeIntegrationMarker } from "./core.mjs"

export * from "./core.mjs"

/** Recognisable secrets: none may ever appear in an RPC output, an event, a route answer or a log line. */
export const FAKE_INTEGRATION_SENTINELS = Object.freeze({
  token: "5e471e15e471e15e471e15e471e15e471e15e471e15e471e15e471e15e471e1a",
  scriptHandle: "fixture-sentinel-script-handle",
  offerKey: "fixture-sentinel-offer-key",
  bindingKey: "fixture-sentinel-binding-key",
})

/** Names of the sentinels found in `value`; the port is searched as a number and as a digit run, except in `offerID`. */
export function findSentinels(value, { port, sentinels = FAKE_INTEGRATION_SENTINELS } = {}) {
  const found = new Set()
  const digits = port === undefined ? null : new RegExp(`(^|\\D)${port}(\\D|$)`)
  const visit = (current, key) => {
    if (typeof current === "number" && current === port) found.add("port")
    if (typeof current === "string") {
      for (const [name, secret] of Object.entries(sentinels)) if (current.includes(secret)) found.add(name)
      if (digits && key !== "offerID" && digits.test(current)) found.add("port")
    } else if (Array.isArray(current)) for (const item of current) visit(item, key)
    else if (typeof current === "object" && current !== null) for (const [name, item] of Object.entries(current)) { visit(name, null); visit(item, name) }
  }
  visit(value, null)
  return [...found]
}

export function assertNoSentinels(value, options, label = "value") {
  assert.deepEqual(findSentinels(value, options), [], `${label} carries no host secret`)
}

const DEFAULT_CAPABILITIES = { methods: ["context", "apply"], operations: [{ name: "node.create", undoable: true }], undo: "grouped_best_effort", background: true }

/**
 * A loopback host of protocol 1 answering `hello` with the sentinel token and script handle. `leaky` puts the
 * script handle in its document and its port in its application version, which a plugin must not copy (HST-11).
 */
export async function startFakeHost({ token = FAKE_INTEGRATION_SENTINELS.token, scriptHandle = FAKE_INTEGRATION_SENTINELS.scriptHandle,
  protocol = 1, hostVersion = "0.1.0", appVersion = "1.0.0", document = "fixture-scene.dat", leaky = false, capabilities = DEFAULT_CAPABILITIES } = {}) {
  const requests = [], sockets = new Set()
  let port = 0
  const hello = () => ({ protocol, host_version: hostVersion, app_version: leaky ? `${appVersion} build ${port}` : appVersion,
    capabilities, capability_hash: capabilityHash(capabilities), script_handle: scriptHandle, revision: 0, document: leaky ? scriptHandle : document })
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", chunk => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      let request
      try { request = JSON.parse(buffer.slice(0, newline)) } catch { socket.end('{"id":"","ok":false,"error":{"code":"invalid_request"}}\n'); return }
      const authorized = request.token === token
      requests.push({ method: request.method, authorized })
      const id = typeof request.id === "string" ? request.id : ""
      const reply = body => socket.end(`${JSON.stringify(body)}\n`)
      if (!authorized) return reply({ id, ok: false, error: { code: "unauthorized" } })
      if (request.method === "hello") return reply({ id, ok: true, result: hello() })
      reply({ id, ok: false, error: { code: "method_not_found" } })
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  port = server.address().port
  return {
    port, token, scriptHandle, requests, hello,
    /** The `advertise` input announcing this host; `overrides` builds invalid or replacing announcements. */
    advertiseInput: (overrides = {}) => ({ host: "127.0.0.1", port, token, script_handle: scriptHandle, label: "Fixture scene",
      protocol, offer_key: FAKE_INTEGRATION_SENTINELS.offerKey, ...overrides }),
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

// Removes `pattern`, which OpenCode's JSON Schema import refuses in RPC definitions ("Patterns may block
// validation and are disabled"); the handlers above keep validating their own input.
const withoutPatterns = value => Array.isArray(value) ? value.map(withoutPatterns) : typeof value === "object" && value !== null
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "pattern").map(([key, item]) => [key, withoutPatterns(item)])) : value

// rpc.schema.json definitions for ctx.rpc.register; advertise and withdraw take an opaque object (RPC-8).
async function rpcDefinition(marker) {
  const schema = JSON.parse(await readFile(new URL("../../../packages/server/src/opencode/integrations/vendor/rpc.schema.json", import.meta.url), "utf8"))
  const definition = name => withoutPatterns(schema.$defs[name])
  const methods = Object.fromEntries(["status", "installHost", "hosts", "attachHost", "detachHost", "advertise", "withdraw"].map(method =>
    [method, { input: ["advertise", "withdraw"].includes(method) ? { type: "object" } : definition(`${method}.input`), output: definition(`${method}.output`) }]))
  const events = Object.fromEntries(["status_changed", "hosts_changed"].map(event => [event, { schema: { ...definition(`${event}.event`), type: "object" } }]))
  return { id: marker.rpc, methods, events }
}

/**
 * Writes the installable fake integration package into `directory`: the `opencodeIntegration` marker, the native
 * RPC contract over a daemon-wide offer registry, and the fixture options (`markerMismatch`, `hostPart`,
 * `installOutcome`). `id` changes the integration ID, package name and RPC ID together.
 */
export async function writeFakeIntegrationPackage(directory, { id = "fixture", name, version = FAKE_INTEGRATION_VERSION, markerMismatch = false,
  hostPart = "absent", installOutcome = "installed" } = {}) {
  const marker = fakeIntegrationMarker(id)
  const packageName = name ?? (id === "fixture" ? FAKE_INTEGRATION_PACKAGE : `@neuralnomads/opencode-${id}`)
  await mkdir(directory, { recursive: true })
  await copyFile(new URL("./core.mjs", import.meta.url), path.join(directory, "core.mjs"))
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name: packageName, version, type: "module",
    exports: { ".": "./index.js" }, opencodeIntegration: marker }, null, 2)}\n`)
  const options = { marker, version, markerMismatch, hostPart, installOutcome }
  await writeFile(path.join(directory, "index.js"), `import { createFakeIntegrationRpc, sharedOfferRegistry } from "./core.mjs"
const options = ${JSON.stringify(options)}
const definition = ${JSON.stringify(await rpcDefinition(marker))}
export default { id: options.marker.plugin, async setup(ctx) {
  const rpc = createFakeIntegrationRpc({ ...options, registry: sharedOfferRegistry(options.marker) })
  const registration = await ctx.rpc.register(definition, rpc.handlers)
  const disconnect = rpc.connect(registration)
  return async () => { disconnect(); await registration.dispose?.() }
} }
`)
  return { directory, name: packageName, version, marker }
}

/** The fake integration as an npm tarball (`package/` root), for the loopback fake registry. */
export async function packFakeIntegration(root, options = {}) {
  const staging = path.join(root, `fake-integration-${options.id ?? "fixture"}-${options.version ?? FAKE_INTEGRATION_VERSION}`)
  const written = await writeFakeIntegrationPackage(path.join(staging, "package"), options)
  const tarball = `${staging}.tgz`
  const tar = spawnSync("tar", ["-czf", tarball, "-C", staging, "package"], { encoding: "utf8", windowsHide: true })
  assert.equal(tar.status, 0, tar.stderr)
  return { ...written, tarball: await readFile(tarball) }
}
