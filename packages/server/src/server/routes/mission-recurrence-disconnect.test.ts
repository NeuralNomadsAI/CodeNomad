import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { request as httpRequest } from "node:http"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import { recurrenceHumanRequestID } from "../../missions/recurrence-authority-contract"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "./mission-recurrence-control-status"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

for (const neverResolved of [false, true]) test(`HTTP disconnect retains native write permit until ${neverResolved ? "explicit positive exact receipt" : "the original ACK"}`, async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "play-disconnect-"))
  const app = Fastify({ logger: false })
  let ack!: (value: unknown) => void
  const nativeWrite = new Promise<unknown>(resolve => { ack = resolve })
  let closeObserved!: () => void
  const disconnected = new Promise<void>(resolve => { closeObserved = resolve })
  try {
    execFileSync("git", ["init", "-q", base])
    const directory = realpathSync(base), yaml = path.join(base, "selected.yml")
    await writeFile(yaml, "server: {}\n")
    const profile = canonicalScope("stable", yaml, base, base)
    const auth = new AuthManager({ configPath: base, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
    const human = auth.createSession("human"), workspace = {}, location = { directory }, fence = new WorktreeDeletionFence(10_000)
    const requestID = recurrenceHumanRequestID("daily_review", 1, "authorize")
    let dispatched!: () => void
    const started = new Promise<void>(resolve => { dispatched = resolve })
    let writes = 0, reads = 0, positive = false
    const receipt = { version: 1, scheduleID: "daily_review", requestID, revision: 1, state: "running", epoch: 1, controlsComplete: true }
    const client = { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) }, rpc: () => ({
      recurrenceControl: (_input: unknown, options: { signal?: AbortSignal }) => {
        assert.equal(options.signal, undefined, "admitted native WRITE has no HTTP observer cancellation")
        writes++; dispatched(); return nativeWrite
      }, recurrenceControlStatus: async () => {
        reads++
        return { version: 1, scheduleID: "daily_review", requestID, expectedRevision: 0, epoch: 1,
          outcome: positive ? "committed" : "unknown", ...(positive ? { state: "running", revision: 1, controlsComplete: true } : {}) }
      },
    }) }
    const originalConnection = { client, assertCurrent: () => {} }
    let connection = originalConnection
    const manager = { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
      getSharedServiceConnection: async () => connection, ownsLocation: async () => true,
      getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory }
    app.addHook("onRequest", (request, reply, done) => {
      if (request.url.endsWith("/control")) reply.raw.once("close", closeObserved)
      done()
    })
    registerMissionRecurrenceControl(app, { auth, manager, fence, bridgeToken: "existing-bridge-token",
      settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => profile } } as never)
    registerMissionRecurrenceControlStatus(app, { auth, manager, fence } as never)
    await app.listen({ host: "127.0.0.1", port: 0 })
    const url = "/api/workspaces/owned/missions/recurrence/daily_review/control"
    const payload = { action: "play", expectedRevision: 0, expectedEpoch: 0, requestID }
    const cookie = `${auth.getCookieName()}=${human.id}`
    const outgoing = httpRequest({ hostname: "127.0.0.1", port: (app.server.address() as { port: number }).port,
      path: url, method: "POST", headers: { "content-type": "application/json", cookie } })
    outgoing.on("error", () => {})
    outgoing.end(JSON.stringify(payload))
    await started
    outgoing.destroy()
    await disconnected
    let deletionEntered = false
    const deletion = fence.run(directory, [directory], async () => { deletionEntered = true })
    await turn()
    assert.equal(deletionEntered, false, "downstream close cannot release an admitted native WRITE")
    assert.deepEqual([writes, reads], [1, 0], "socket close is neither a replay nor a no-effect/status receipt")
    if (neverResolved) {
      const unknown = await app.inject({ method: "POST", url: `${url}/status`, payload, headers: { cookie } })
      assert.equal(unknown.statusCode, 200)
      assert.equal(unknown.json().outcome, "unknown")
      assert.equal(deletionEntered, false, "negative exact ledger read is not no-effect evidence")
      const repeat = await app.inject({ method: "POST", url, payload, headers: { cookie } })
      assert.equal(repeat.statusCode, 503)
      assert.equal(writes, 1, "the exact outstanding action cannot be dispatched again")
      positive = true
      connection = { client, assertCurrent: () => {} } // Normal replacement discovery, not the original native store/claim.
      const replacement = await app.inject({ method: "POST", url: `${url}/status`, payload, headers: { cookie } })
      assert.equal(replacement.statusCode, 503)
      assert.equal(deletionEntered, false, "a matching receipt through a replacement connection cannot release the original writer")
      assert.equal(reads, 1, "the replacement never borrows the held root's settlement read")
      connection = originalConnection
      const known = await app.inject({ method: "POST", url: `${url}/status`, payload, headers: { cookie } })
      assert.equal(known.statusCode, 200)
      assert.equal(known.json().outcome, "committed")
      await deletion
      assert.equal(writes, 1)
      assert.equal(reads, 2)
      // Leave the ORIGINAL native promise unresolved: only positive exact signed
      // ledger publication releases this mutation-admission hold, never an ACK race.
    } else {
      ack(receipt)
      await deletion
      assert.equal(reads, 0, "the original validated ACK is enough despite a closed observer")
    }
    assert.equal(deletionEntered, true)
  } finally { await app.close(); await rm(base, { recursive: true, force: true }) }
})
