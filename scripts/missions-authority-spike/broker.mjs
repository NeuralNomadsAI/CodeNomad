// Private admission adapter using the actual existing backend route and one manager/fence.
import { randomUUID } from "node:crypto"
import { readFile, realpath, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import { canonical, POLICY, RPC } from "./protocol.mjs"
import { familyIdentity } from "./family-ownership.mjs"

export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(temporary, file)
}
export function freshSettings(file, observations) {
  const reader = { getOwner() {
    const value = JSON.parse(readFileSync(file, "utf8"))
    if (!value || Object.keys(value).join(",") !== "environmentVariables" || !value.environmentVariables
      || typeof value.environmentVariables !== "object" || Array.isArray(value.environmentVariables)
      || !Object.entries(value.environmentVariables).every(([key, v]) => key && !key.includes("=") && !key.includes("\0") && typeof v === "string" && !v.includes("\0"))) throw new Error("Invalid private profile settings")
    observations.settingsReads++
    return value
  }, async readEnvironmentForAdmission(signal) {
    signal?.throwIfAborted()
    return reader.getOwner().environmentVariables
  } }
  return reader
}
export async function startBroker(options) {
  const { admitMissionInput } = await tsImport("../../packages/server/src/server/routes/mission-input.ts", import.meta.url)
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 })
  const trace = [], faults = { environment: false, interruptTarget: undefined, afterEnvironment: undefined }
  const safeReasons = new Set(["Host authority registry rejected", "Native authority namespace rejected", "Profile authority mismatch", "Coordinator identity mismatch", "Missing durable contract", "Grant revoked", "Exact project root rejected", "Invalid authority request", "Mission input differs from its durable contract", "Mission is not running",
    "Missing mission owner", "No pending mission control authority", "Foreign mission actor", "Mission actor is shared", "Mission control superseded", "Missing mission worktree", "Worktree mutation in progress", "Mission actor moved", "Coordinator moved", "Workspace is not ready"])
  let queue = Promise.resolve(), sequence = 0, currentBody
  const exclusive = action => {
    const result = queue.catch(() => {}).then(action)
    queue = result.then(() => {}, () => {})
    return result
  }
  const manager = Object.fromEntries(["list", "ownsLocation", "getWorktreeIdentityForPath", "getSessionEnvironment"].map(name => [name, (...args) => options.manager[name](...args)]))
  manager.getSharedServiceConnection = async id => {
    const connection = await options.manager.getSharedServiceConnection(id)
    const session = { ...connection.client.session,
      environment: async (input, requestOptions) => {
        trace.push({ sequence: ++sequence, operation: "environment", sessionID: input.sessionID })
        if (faults.environment) { faults.environment = false; throw new Error("PRIVATE_ENV_SECRET_MUST_NOT_ESCAPE") }
        const result = await connection.client.session.environment(input, requestOptions)
        if (faults.afterEnvironment) { const action = faults.afterEnvironment; faults.afterEnvironment = undefined; await action() }
        return result
      },
      prompt: async (input, requestOptions) => {
        await validate(currentBody)
        trace.push({ sequence: ++sequence, operation: "prompt", sessionID: input.sessionID, messageID: input.id })
        return connection.client.session.prompt(input, requestOptions)
      },
      synthetic: async (input, requestOptions) => {
        await validate(currentBody)
        trace.push({ sequence: ++sequence, operation: "synthetic", sessionID: input.sessionID, messageID: input.id })
        return connection.client.session.synthetic(input, requestOptions)
      },
      interrupt: async (input, requestOptions) => {
        if (faults.interruptTarget === input.sessionID) { faults.interruptTarget = undefined; throw new Error("Private interrupt failure") }
        return connection.client.session.interrupt(input, requestOptions)
      },
    }
    return { ...connection, client: { ...connection.client, session } }
  }
  async function validate(body) {
    await options.claim.assertCurrent()
    const record = JSON.parse(await readFile(options.registry, "utf8"))
    if (record.state !== "active" || record.policy !== POLICY || record.family !== options.claim.owner.family || record.profileID !== options.profileID
      || !record.grant || canonical(record.grant) !== canonical(body.grant)) throw new Error("Host authority registry rejected")
    const nonce = randomUUID()
    const native = await options.client.rpc(RPC).challenge({ nonce }, { location: options.location, signal: AbortSignal.timeout(10_000) })
    if (native.nonce !== nonce || native.policy !== POLICY || native.namespace !== record.grant.namespace
      || native.projectID !== record.grant.projectID || native.projectCanonical !== record.grant.projectCanonical
      || !native.grants.some(g => canonical(g) === canonical(body.grant))) throw new Error("Native authority namespace rejected")
    for (const field of ["authorityID", "executionHost", "profileID"]) if (record.grant[field] !== options[field]) throw new Error("Profile authority mismatch")
    if (body.coordinatorID !== record.grant.coordinatorID) throw new Error("Coordinator identity mismatch")
    const snapshot = await options.client.rpc(options.missionsRPC).snapshot({}, { location: options.location })
    const mission = snapshot.missions.find(m => m.id === record.grant.missionID)
    if (!mission || mission.projectID !== record.grant.projectID) throw new Error("Missing durable contract")
    if (record.grant.state !== "active") {
      if (body.kind !== "lifecycle" || mission.control?.action !== "stop" || body.input.operationID !== mission.control.id) throw new Error("Grant revoked")
    }
    const targetID = body.input.sessionID
    for (const id of new Set([body.coordinatorID, targetID])) {
      const actor = mission.actors.find(a => a.sessionId === id)
      const session = await options.client.session.get({ sessionID: id })
      if (!actor || session.parentID || session.projectID !== mission.projectID || actor.location.directory !== session.location.directory
        || session.location.directory !== record.grant.roots[0]
        || await realpath(session.location.directory) !== await realpath(record.grant.roots[0])
        || await familyIdentity(session.location.directory) !== record.family) throw new Error("Exact project root rejected")
    }
    return mission
  }
  app.post("/admission", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.token}`) return reply.code(403).send({ code: "unauthorized" })
    try {
      const body = request.body
      if (!body || Object.keys(body).sort().join(",") !== "coordinatorID,grant,input,kind" || !["prompt", "synthetic", "lifecycle"].includes(body.kind)) throw new Error("Invalid authority request")
      return await exclusive(async () => {
        currentBody = body
        try {
          await validate(body)
          // Payload matching and per-send environment are the real product implementation.
          return await admitMissionInput(manager, options.fence, body.coordinatorID, { kind: body.kind, input: body.input }, new AbortController().signal)
        } finally { currentBody = undefined }
      })
    } catch (error) {
      trace.push({ sequence: ++sequence, operation: "rejected", reason: safeReasons.has(error.message) ? error.message : "private-admission-failure",
        diagnosticType: error.name, frames: error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 3),
        fields: error.issues?.map(issue => ({ path: issue.path, code: issue.code })) })
      return reply.code(409).send({ code: "authority-admission-rejected" })
    }
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, trace, faults, exclusive, url: `http://127.0.0.1:${app.server.address().port}/admission` }
}
