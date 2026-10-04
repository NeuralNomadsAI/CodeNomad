// Owned fixture-only descendant admission; native family/call/location checks,
// real fresh manager snapshot and deletion fence. Not production authority.
import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { tsImport } from "tsx/esm/api"
import { registerHooks, createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { freshSettings } from "../../missions-authority-spike/broker.mjs"
import { RPC } from "./schema.mjs"
import { fingerprintEnvironment, compareEnvironment, retainBackend, EXPECTED_ABSENT } from "./environment-evidence.mjs"
export async function backendServer(h) {
  // Read-only workspace-local dependencies omitted from the rollback checkout.
  // Resolve missing bare imports only; never redirect source modules or install.
  const dependencyRequire = createRequire("D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f/packages/server/package.json")
  const dependencyHook = registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) throw error
      return { url: pathToFileURL(dependencyRequire.resolve(specifier)).href, shortCircuit: true }
    }
  } })
  const load = file => tsImport(new URL(`../../../packages/server/src/${file}`, import.meta.url).href, import.meta.url)
  const [{ WorkspaceManager }, { EventBus }, { rememberRuntime }, { registerInstanceProxyRoutes }, { WorktreeDeletionFence }, { AuthManager }] = await Promise.all([
    load("workspaces/manager.ts"), load("events/bus.ts"), load("opencode/compatibility/runtime.ts"), load("server/http-server.ts"), load("workspaces/worktree-session-evacuation.ts"), load("auth/manager.ts")])
  const endpoint = { url: h.running.url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  rememberRuntime(endpoint, { version: h.running.info.version, pid: h.running.info.pid, discovery: "info" })
  const logger = pino({ level: "silent" }), scope = new AsyncLocalStorage(), observations = { settingsReads: 0 }, profiles = new Map(), trace = []
  const backendGeneration = h.backendSequence = (h.backendSequence ?? 0) + 1, backendID = randomUUID()
  let sourceReadOrdinal = 0
  const defaultFile = `${h.root}/profile-default.json`; await writeFile(defaultFile, JSON.stringify({ environmentVariables: {} }))
  const defaults = freshSettings(defaultFile, observations)
  const manager = new WorkspaceManager({ rootDir: h.root, logger, eventBus: new EventBus(), settings: { getOwner: (...args) => defaults.getOwner(...args), readEnvironmentForAdmission: signal => freshSettings(scope.getStore() ?? defaultFile, observations).readEnvironmentForAdmission(signal) },
    binaryResolver: { resolveDefault: () => ({ path: h.cli, label: "Private recursion qualification" }) }, hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const freshSource = async (profileFile, signal) => {
    const profileFingerprint = fingerprintEnvironment(JSON.parse(await readFile(profileFile, "utf8")).environmentVariables)
    const settingsReadsBefore = observations.settingsReads
    const variables = await scope.run(profileFile, () => manager.getSessionEnvironment(workspace.id, signal))
    const sourceFingerprint = fingerprintEnvironment(variables)
    assert(observations.settingsReads > settingsReadsBefore, "Fresh source-built settings read")
    assert(compareEnvironment(profileFingerprint, sourceFingerprint).sourceAllKeysEquivalent, "Exact configured profile hashes in complete source map")
    for (const key of EXPECTED_ABSENT) assert(!sourceFingerprint.keys.some(item => item.key === key), "Private key excluded from complete input: " + key)
    const ordinal = ++sourceReadOrdinal
    return { variables, evidence: { phase: h.result.phase, backendID, backendGeneration, sourceReadOrdinal: ordinal,
      dispatchID: `${backendID}:source-${ordinal}`, sourceBuiltAt: Date.now(), settingsReadsBefore, settingsReadsAfter: observations.settingsReads,
      sourceFingerprint, profileFingerprint, variableCount: sourceFingerprint.rawKeyCount, snapshotSHA256: sourceFingerprint.canonicalSHA256,
      fingerprintFormat: sourceFingerprint.format, expectedAbsent: EXPECTED_ABSENT } }
  }
  const { workspace } = await manager.create(h.project)
  const app = Fastify({ logger: false }), fence = new WorktreeDeletionFence()
  const password = randomUUID(), auth = new AuthManager({ configPath: `${h.root}/backend.yaml`, username: "fixture", password, generateToken: false }, logger)
  assert(auth.validateLogin("fixture", password)); const cookie = `${auth.getCookieName()}=${auth.createSession("fixture").id}`
  let active = true, generation = 1
  const settlementHolds = new Map(), faults = new Map()
  app.addHook("preHandler", async (request, reply) => { if (!auth.isLoopbackRequest(request) || !auth.getSessionFromRequest(request)) return reply.code(403).send({ error: "private-only" }) })
  app.addHook("preHandler", async (request, reply) => {
    const mutation = request.method === "POST" && request.raw.url.match(/\/api\/session\/([^/?]+)\/(prompt|command|shell|synthetic)(?:\?|$)/)
    if (mutation) {
      const family = await h.family(decodeURIComponent(mutation[1])), rootID = family.at(-1).id
      const stored = await h.rpc("inspect"), policy = stored.policies.find(record => record.key === `policy/${rootID}`)?.value
      if (!profiles.has(rootID) || !await manager.ownsLocation(workspace.id, family[0].location) || (policy?.gate && policy.state !== "running")) {
        trace.push({ operation: "owned-route-denied", sessionID: family[0].id, rootID, entrypoint: mutation[2] })
        return reply.code(409).send({ error: "private-lifecycle-admission-denied" })
      }
    }
    const sessionID = request.params?.sessionID
    if (sessionID && profiles.has(sessionID)) await new Promise((resolve, reject) => scope.run(profiles.get(sessionID), () => { scope.enterWith(profiles.get(sessionID)); resolve() }))
  })
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger, worktreeDeletionFence: fence })
  app.post("/private/recursive-environment", { bodyLimit: 4096 }, async (request, reply) => {
    let release
    try {
      const body = request.body, fields = ["parentID", "childID", "callID", "messageID", "rootID", "generation"]
      if (!body || Object.keys(body).sort().join() !== [...fields].sort().join() || fields.slice(0, 5).some(field => typeof body[field] !== "string" || !body[field] || body[field].length > 240) || !Number.isSafeInteger(body.generation) || body.generation < 1) throw new Error("Invalid binding")
      const connection = await manager.getSharedServiceConnection(workspace.id), version = generation
      const signal = AbortSignal.timeout(15_000)
      const check = () => { if (!active || version !== generation) throw new Error("Backend detached"); connection.assertCurrent() }
      check()
      const family = await h.family(body.childID)
      if (family[0].parentID !== body.parentID || family.at(-1).id !== body.rootID || !profiles.has(body.rootID)) throw new Error("Unknown family")
      for (const session of family) if (!await manager.ownsLocation(workspace.id, session.location, connection.client)) throw new Error("Foreign location")
      const records = await h.rpc("inspect")
      const binding = records.bindings.find(record => record.key === `binding/${body.parentID}/${body.callID}`)?.value
      if (JSON.stringify(binding) !== JSON.stringify(body)) throw new Error("Binding mismatch")
      const policy = records.policies.find(record => record.key === `policy/${body.rootID}`)?.value
      if (policy?.state !== "running" || policy.generation !== body.generation) throw new Error("Generation denied")
      const messages = await h.messages(body.parentID)
      const tool = messages.find(message => message.id === body.messageID)?.content?.find(part => part.type === "tool" && part.id === body.callID)
      if (tool?.name !== "subagent" || tool.state.status !== "running") throw new Error("No actual running native call")
      const identities = await Promise.all(family.map(session => manager.getWorktreeIdentityForPath(workspace.id, session.location.directory)))
      if (identities.some(identity => !identity)) throw new Error("Unknown mutation identity")
      release = fence.enter(identities); if (!release) throw new Error("Deletion fenced")
      const { variables, evidence } = await freshSource(profiles.get(body.rootID), signal); check()
      const dispatched = { ...body, ...evidence, operation: "environment-dispatch", dispatchAt: Date.now() }
      trace.push(dispatched)
      await connection.client.session.environment({ sessionID: body.childID, variables }, { signal }); check()
      assert.equal(fingerprintEnvironment(variables).canonicalSHA256, evidence.sourceFingerprint.canonicalSHA256, "SDK did not mutate complete input")
      const writtenAt = Date.now()
      trace.push({ ...dispatched, operation: "environment-written", writtenAt, time: writtenAt })
      if (faults.get(body.rootID) === "write-settlement") {
        trace.push({ ...body, operation: "write-settlement-held", time: Date.now() })
        await new Promise(resolve => { const timeout = setTimeout(resolve, 10_000); settlementHolds.set(body.childID, () => { clearTimeout(timeout); resolve() }) })
        settlementHolds.delete(body.childID); check()
      }
      return { admitted: true }
    } catch (error) { trace.push({ operation: "denied", reason: error.message }); return reply.code(409).send({ error: "private-admission-denied" }) }
    finally { release?.() }
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`
  await writeFile(`${h.root}/admission-seed.json`, JSON.stringify({ url: `${base}/private/recursive-environment`, cookie }))
  const proxy = OpenCode.make({ baseUrl: `${base}/workspaces/${workspace.id}/instance/`, headers: { cookie } })
  const backend = { profiles, trace, observations, manager, proxy, faults, settlementHolds, backendID, backendGeneration,
    async applyRoot(sessionID) {
      const session = await h.running.client.session.get({ sessionID })
      if (session.parentID || !await manager.ownsLocation(workspace.id, session.location)) throw new Error("Unknown root")
      const { variables, evidence } = await freshSource(profiles.get(sessionID))
      const dispatched = { ...evidence, operation: "root-environment-dispatch", sessionID, childID: sessionID, rootID: sessionID, dispatchAt: Date.now() }
      trace.push(dispatched)
      await h.running.client.session.environment({ sessionID, variables })
      const writtenAt = Date.now(); trace.push({ ...dispatched, operation: "root-environment", writtenAt, time: writtenAt })
    },
    async close() {
      if (!active) return
      retainBackend(h, backend, "before-close")
      active = false; generation++; for (const release of settlementHolds.values()) release()
      await app.close(); await manager.shutdown(); dependencyHook.deregister()
      retainBackend(h, backend, "after-close")
    } }
  return backend
}
