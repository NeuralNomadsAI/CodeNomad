// Fixture-only composition of existing ownership/connection/deletion/settings
// primitives. NOT a signed Missions authority, native attestation or public RPC.
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"

const fields = ["parentID", "callID", "childID", "rootRequestID", "executionID", "taskKey", "contractRequestID"]
const tuple = binding => Object.fromEntries(fields.map(field => [field, binding[field]]))
const same = (a, b) => isDeepStrictEqual(a, b)
const key = value => `${value.parentID}/${value.callID}`
const hold = signal => {
  let release
  const promise = new Promise((resolve, reject) => {
    release = resolve
    if (signal.aborted) reject(new Error("Admission aborted"))
    else signal.addEventListener("abort", () => reject(new Error("Admission aborted")), { once: true })
  })
  return { promise, release }
}

export function childAdmission({ app, authManager, manager, workspace, fence, scope, defaultFile, rpcSchema, deadline }) {
  const records = new Map(), profiles = new Map(), observed = new Map(), trace = [], holds = new Map()
  const fixtureWriters = new Set()
  let mode = "baseline", lifetimeGeneration = 1
  const lifetime = new AbortController()
  const note = (record, operation, extra = {}) => trace.push({ operation, parentID: record.parentID, callID: record.callID, ...extra })
  const assertLive = (record, generation, lifetimeVersion, signal) => {
    signal.throwIfAborted()
    if (lifetime.signal.aborted || lifetimeVersion !== lifetimeGeneration || record.generation !== generation) throw new Error("Fixture lifecycle superseded")
    record.connection.assertCurrent()
    if (record.mode === "explicit" && profiles.get(record.parentID) !== record.file) throw new Error("Approved scope changed")
  }
  const validate = body => {
    if (!body || Object.keys(body).length !== fields.length || fields.some(field => typeof body[field] !== "string" || !body[field] || body[field].length > 240)
      || Object.keys(body).some(field => !fields.includes(field))) throw new Error("Invalid identity-only request")
    return body
  }
  async function nativeContext(record, body, signal) {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (connection !== record.connection) throw new Error("Connection changed")
    connection.assertCurrent()
    const client = connection.client
    const [parent, child] = await Promise.all([client.session.get({ sessionID: body.parentID }, { signal }), client.session.get({ sessionID: body.childID }, { signal })])
    if (parent.id !== record.parentID || parent.parentID || child.id !== body.childID || child.parentID !== parent.id
      || parent.projectID !== record.parent.projectID || child.projectID !== parent.projectID
      || !same(parent.location, record.parent.location) || !same(child.location, parent.location)
      || !await manager.ownsLocation(workspace.id, parent.location, client) || !await manager.ownsLocation(workspace.id, child.location, client)) {
      throw new Error("Native owner/location changed")
    }
    // The private plugin binding is trusted ONLY by explicit fixture construction.
    // Verify actual native running tool + actual accepted root user message too.
    const { binding } = await client.rpc(rpcSchema).proof({ token: record.proofToken, parentID: parent.id, callID: body.callID },
      { location: { directory: parent.location.directory }, signal })
    if (!binding || !same(tuple(binding), body)) throw new Error("No observed immutable native binding")
    const page = await client.message.list({ sessionID: parent.id, limit: { order: "desc", limit: 100 } }, { signal })
    const root = page.data.find(message => message.id === body.rootRequestID)
    const assistant = page.data.find(message => message.id === binding.assistantMessageID)
    const part = assistant?.content?.find(part => part.type === "tool" && part.id === body.callID)
    if (root?.type !== "user" || root.metadata?.["private.child.environment"]?.rootRequestID !== body.rootRequestID || !part || part.name !== "subagent"
      || part.state.status !== "running" || (part.state.metadata?.sessionID && part.state.metadata.sessionID !== child.id)) throw new Error("Actual native call/request mismatch")
    if (binding.nativeAgent !== (child.agent ?? null) || !same(binding.nativeModel, child.model ?? null)) throw new Error("Child execution selection changed")
    connection.assertCurrent(); signal.throwIfAborted()
    return { parent, child, binding, metadataPublished: part.state.metadata?.sessionID === child.id }
  }
  for (const operation of ["observe", "admit"]) app.post(`/private/child-environment/${operation}`, { bodyLimit: 4096 }, async (request, reply) => {
    let record, release, writerChild
    const disconnected = new AbortController()
    const onClose = () => { if (!reply.raw.writableEnded) disconnected.abort() }
    reply.raw.once("close", onClose)
    try {
      if (!authManager.isLoopbackRequest(request) || !authManager.getSessionFromRequest(request)) throw new Error("Unauthenticated child admission")
      const body = validate(request.body)
      record = records.get(key(body))
      if (!record || !same(tuple({ ...record.contract, childID: body.childID }), body)) throw new Error("Unknown invocation")
      const generation = record.generation, lifetimeVersion = lifetimeGeneration
      const signal = AbortSignal.any([disconnected.signal, record.controller.signal, lifetime.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      const check = () => assertLive(record, generation, lifetimeVersion, signal)
      check()
      const context = await nativeContext(record, body, signal); check()
      if (operation === "observe") {
        const previous = observed.get(key(body))
        if (previous && !same(previous, context.binding)) throw new Error("Observed binding changed")
        observed.set(key(body), structuredClone(context.binding))
        note(record, "observed", { childID: body.childID, metadataPublished: context.metadataPublished, requestFields: Object.keys(body).sort(), responseFields: ["observed"] })
        return { observed: true }
      }
      if (!same(observed.get(key(body)), context.binding)) throw new Error("No trusted progress observation")
      if (record.attempted) throw new Error("Admission is not replayable")
      record.attempted = true
      if (record.mode === "baseline") { record.admitted = true; note(record, "baseline-no-write", { childID: body.childID }); return { admitted: true } }
      if (!record.file) throw new Error("No approved server profile")
      // Narrow local mutual exclusion only, never a native/session writer claim.
      if (fixtureWriters.has(body.childID)) throw new Error("Fixture child writer busy")
      fixtureWriters.add(body.childID); writerChild = body.childID
      const identities = await Promise.all([context.parent, context.child].map(session => manager.getWorktreeIdentityForPath(workspace.id, session.location.directory)))
      check()
      if (identities.some(identity => !identity)) throw new Error("Unknown mutation identity")
      release = fence.enter(identities)
      if (!release) throw new Error("Deletion admission blocked")
      const variables = await scope.run(record.file, () => manager.getSessionEnvironment(workspace.id, signal)); check()
      await nativeContext(record, body, signal); check()
      if (record.fault === "reject-real-api") {
        // Real native 404 injection at dispatch, not a stubbed SDK rejection.
        // This private, newly born child has never received a model request.
        await record.connection.client.session.remove({ sessionID: body.childID }, { signal }); check()
      }
      note(record, "environment-dispatch", { childID: body.childID })
      // No product applySessionEnvironment export exists: compose the same actual
      // manager snapshot + native API used by the owned session-send route.
      try { await record.connection.client.session.environment({ sessionID: body.childID, variables }, { signal }) }
      catch (error) {
        note(record, "native-environment-rejected", { errorType: error?._tag === "SessionNotFoundError" ? "SessionNotFoundError" : "native-api-rejection" })
        throw new Error("Environment API rejected")
      }
      note(record, "environment-written", { childID: body.childID }); check()
      if (record.fault === "hold-real-write-settlement") {
        const latch = hold(signal); holds.set(record.callID, latch)
        note(record, "write-settlement-held", { childID: body.childID })
        try { await latch.promise } finally { holds.delete(record.callID) }
        check()
      }
      await nativeContext(record, body, signal); check()
      record.admitted = true
      note(record, "admitted", { childID: body.childID, responseFields: ["admitted"] })
      return { admitted: true }
    } catch (error) {
      const safe = ["Actual native call/request mismatch", "Native owner/location changed", "No observed immutable native binding", "Connection changed", "Child execution selection changed", "Deletion admission blocked", "Unknown mutation identity", "No approved server profile", "No trusted progress observation", "Fixture lifecycle superseded", "Approved scope changed"]
      if (record) note(record, "denied", { reason: safe.includes(error.message) ? error.message : "private-admission-rejected" })
      // Never return/log SDK errors, profile bytes or credentials.
      return reply.code(409).send({ error: "child-environment-admission-denied" })
    } finally { release?.(); if (writerChild) fixtureWriters.delete(writerChild); reply.raw.off("close", onClose) }
  })
  return { trace, holds, setMode(value) { assert.equal(value, "explicit"); mode = value },
    approveRoot(parentID, file) { profiles.set(parentID, file) },
    async record(contract, proofToken, fault) {
      if (records.has(key(contract))) throw new Error("Immutable fixture invocation already recorded")
      const connection = await manager.getSharedServiceConnection(workspace.id)
      if (!connection) throw new Error("No owned connection")
      const parent = await connection.client.session.get({ sessionID: contract.parentID })
      connection.assertCurrent()
      records.set(key(contract), { ...contract, contract: structuredClone(contract), connection, parent, mode,
        file: mode === "explicit" ? profiles.get(parent.id) : defaultFile, proofToken, fault, generation: 1, controller: new AbortController() })
    },
    revoke(callID) { for (const record of records.values()) if (record.callID === callID) { record.generation++; record.controller.abort() } },
    async blockDeletion(action) {
      const identity = await manager.getWorktreeIdentityForPath(workspace.id, workspace.path)
      if (!identity) throw new Error("No deletion identity")
      return fence.run(identity, [identity], action)
    },
    dispose() { lifetimeGeneration++; lifetime.abort(); for (const latch of holds.values()) latch.release() },
  }
}
