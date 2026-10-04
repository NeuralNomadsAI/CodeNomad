// Private authenticated bridge using the actual backend, not a second journal or
// Mission action engine. Native callbacks revalidate only; never mutate under the
// plugin's project lock. Registry entries originate from runner-verified signatures.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import { familyIdentity } from "../missions-authority-spike/family-ownership.mjs"
import { FIXTURE_RPC } from "./schema.mjs"

export async function startDurableBroker(options) {
  const { admitMissionInput } = await tsImport("../../packages/server/src/server/routes/mission-input.ts", import.meta.url)
  const { canonicalAuthority, authorityDigest, MISSION_AUTHORITY_POLICY } = await tsImport("../../packages/server/src/missions/authority-protocol.ts", import.meta.url)
  const { CODENOMAD_MISSIONS_AUTHORITY_RPC } = await tsImport("../../packages/server/src/missions/authority-rpc.ts", import.meta.url)
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 })
  const trace = options.trace ?? [], faults = { afterEnvironment: undefined }
  const safeReasons = new Set(["Protected host grant mismatch", "Protected host binding mismatch", "Protected coordinator mismatch",
    "Original signed intent mismatch", "Privileged intent kind mismatch", "Stop denial not published", "Host grant revoked", "Host sends disabled",
    "Native mirror mismatch", "No pending immutable native receipt", "Native sends blocked", "Native mission mismatch", "Exact physical actor root mismatch",
    "Native callback did not validate", "Invalid private admission", "Worktree mutation in progress", "Mission input differs from its durable contract"])
  let queue = Promise.resolve(), currentBody, sequence = trace.at(-1)?.sequence ?? 0
  const record = () => JSON.parse(readFileSync(options.registry, "utf8"))
  const same = (a, b) => canonicalAuthority(a) === canonicalAuthority(b)
  const exclusive = operation => {
    const result = queue.catch(() => {}).then(operation)
    queue = result.then(() => {}, () => {})
    return result
  }
  const host = body => {
    const saved = record(), grant = saved.grant
    if (saved.policy !== MISSION_AUTHORITY_POLICY || saved.profileID !== options.profileID || saved.family !== options.claim.owner.family
      || !grant || !body.grant || !same(grant, body.grant)) throw new Error("Protected host grant mismatch")
    for (const field of ["authorityID", "keyID", "profileID", "executionHost"]) if (grant[field] !== options[field]) throw new Error("Protected host binding mismatch")
    if (body.coordinatorID !== grant.coordinatorSessionID) throw new Error("Protected coordinator mismatch")
    if (body.intent) {
      const expected = saved.intents[body.intent.requestID]
      if (!expected || authorityDigest(body.intent) !== expected.digest || !same(body.intent, expected.body)
        || body.intent.epoch !== grant.epoch || body.intent.missionID !== grant.missionID
        || body.intent.namespace !== grant.namespace || body.intent.coordinatorSessionID !== grant.coordinatorSessionID) throw new Error("Original signed intent mismatch")
      if (body.kind === "lifecycle" ? body.intent.method !== "lifecycle" : body.intent.method !== "recover") throw new Error("Privileged intent kind mismatch")
      if (body.intent.method === "lifecycle" && body.intent.payload.action === "stop") {
        if (grant.state !== "revoked" || grant.sendsEnabled) throw new Error("Stop denial not published")
      } else if (grant.state !== "active") throw new Error("Host grant revoked")
    } else if (grant.state !== "active" || !grant.sendsEnabled) throw new Error("Host sends disabled")
    return saved
  }
  const validate = async body => {
    await options.claim.assertCurrent()
    const saved = host(body), grant = saved.grant
    const nonce = randomUUID()
    const rpc = options.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC)
    const native = await rpc.challenge({ nonce }, { location: options.location, signal: AbortSignal.timeout(10_000) })
    const state = await rpc.state({ missionID: grant.missionID }, { location: options.location, signal: AbortSignal.timeout(10_000) })
    if (native.nonce !== nonce || native.policy !== MISSION_AUTHORITY_POLICY || native.namespace !== grant.namespace
      || native.projectID !== grant.projectID || native.projectCanonical !== grant.projectCanonical || !same(state.grant, grant)) throw new Error("Native mirror mismatch")
    if (body.intent && !state.pendingRequestIDs.includes(body.intent.requestID)) throw new Error("No pending immutable native receipt")
    if (!body.intent && (state.terminal || state.pendingRequestIDs.length)) throw new Error("Native sends blocked")
    const snapshot = await options.client.rpc(options.missionsRPC).snapshot({}, { location: options.location })
    const mission = snapshot.missions.find(value => value.id === grant.missionID)
    if (!mission || mission.coordinatorSessionId !== body.coordinatorID || mission.projectID !== grant.projectID) throw new Error("Native mission mismatch")
    for (const id of new Set([body.coordinatorID, body.input.sessionID])) {
      const actor = mission.actors.find(value => value.sessionId === id)
      const session = await options.client.session.get({ sessionID: id })
      if (!actor || session.parentID || session.projectID !== grant.projectID || session.location.directory !== actor.location.directory
        || !grant.roots.some(root => root.directory === session.location.directory)
        || await familyIdentity(session.location.directory) !== options.claim.owner.family
        || await realpath(session.location.directory) !== options.physicalProject) throw new Error("Exact physical actor root mismatch")
    }
    // Repeat the protected read after native RPC/ownership awaits, not a stale copy.
    host(body)
    return mission
  }
  const finalCheckpoint = async body => {
    await validate(body)
    const result = await options.client.rpc(FIXTURE_RPC).checkpoint({ token: options.token, id: body.checkpointID }, {
      location: options.location, signal: AbortSignal.timeout(15_000),
    })
    if (result.current !== true) throw new Error("Native callback did not validate")
    host(body)
    trace.push({ sequence: ++sequence, operation: "checkpoint", missionID: body.grant.missionID, epoch: body.grant.epoch })
  }
  const manager = Object.fromEntries(["list", "ownsLocation", "getWorktreeIdentityForPath", "getSessionEnvironment"].map(name => [name, (...args) => options.manager[name](...args)]))
  manager.getSharedServiceConnection = async id => {
    const connection = await options.manager.getSharedServiceConnection(id)
    const session = { ...connection.client.session,
      environment: async (input, requestOptions) => {
        trace.push({ sequence: ++sequence, operation: "environment", sessionID: input.sessionID })
        const result = await connection.client.session.environment(input, requestOptions)
        if (faults.afterEnvironment) { const action = faults.afterEnvironment; faults.afterEnvironment = undefined; await action() }
        return result
      },
    }
    for (const operation of ["prompt", "synthetic", "interrupt"]) session[operation] = async (input, requestOptions) => {
      await finalCheckpoint(currentBody)
      trace.push({ sequence: ++sequence, operation, sessionID: input.sessionID, messageID: input.id,
        missionID: currentBody.grant.missionID, epoch: currentBody.grant.epoch })
      const result = await connection.client.session[operation](input, requestOptions)
      trace.push({ sequence: ++sequence, operation: "native-ack", kind: operation, sessionID: input.sessionID, messageID: input.id })
      return result
    }
    session.inbox = { ...connection.client.session.inbox, cancel: async (input, requestOptions) => {
      await finalCheckpoint(currentBody)
      trace.push({ sequence: ++sequence, operation: "cancel", sessionID: input.sessionID, inboxID: input.inboxID })
      return connection.client.session.inbox.cancel(input, requestOptions)
    } }
    return { ...connection, client: { ...connection.client, session } }
  }
  app.post("/admission", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.token}`) return reply.code(403).send({ code: "unauthorized" })
    try {
      const body = request.body
      if (!body || Object.keys(body).sort().join(",") !== "checkpointID,coordinatorID,grant,input,intent,kind"
        || !["prompt", "synthetic", "lifecycle"].includes(body.kind) || typeof body.checkpointID !== "string") throw new Error("Invalid private admission")
      return await exclusive(async () => {
        currentBody = body
        try { await validate(body); return await admitMissionInput(manager, options.fence, body.coordinatorID, { kind: body.kind, input: body.input }, AbortSignal.timeout(25_000)) }
        finally { currentBody = undefined }
      })
    } catch (error) {
      trace.push({ sequence: ++sequence, operation: "rejected", diagnostic: safeReasons.has(error?.message) ? error.message : "private admission failed (details redacted)" })
      return reply.code(409).send({ code: "private-admission-rejected" })
    }
  })
  await app.listen({ host: "127.0.0.1", port: options.port ?? 0 })
  return { app, trace, faults, exclusive,
    url: `http://127.0.0.1:${app.server.address().port}/admission` }
}
