import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto"
import { realpathSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/effect"
import { Form } from "@opencode/schema/form"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { authorityDigest, authoritySignerDigest, canonicalAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { MISSION_JOURNAL_STORAGE_PREFIX, stableToken } from "../../missions/journal"
import { selectOneTimeHumanTask } from "./one-time-human-task"
import { matchesExecution } from "../../missions/execution"
import { recurrenceAuthorityDocumentSchema, NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { assertRecurrenceChild, authenticateRecurrenceStanding, recurrenceAuthorityArchiveSchema, recurrenceEffectID,
  type RecurrenceChildGrant, type RecurrenceChildRecord } from "../../missions/recurrence-authority-contract"
import { recurrenceInput } from "../../missions/recurrence-input"
import { controlOperationID } from "../../missions/receipt-identity"
import { physical } from "../../missions/host-authority/private-files"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityPlacementSync } from "../../workspaces/family-authority-claim"
import { humanAnswerBindingInputSchema, humanAnswerBindingSchema, humanAnswerIdentity, humanAnswerQuerySchema,
  humanAnswerRpcInputSchema, humanAnswerSigningBytes, humanDecisionRequestSchema, assertHumanAnswerFresh, matchHumanQuestion, verifyHumanAnswerSignature,
  type HumanAnswerReservation, type HumanAnswerProof } from "../../missions/human-answer"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { verifyHumanAnswerBridge } from "../automation-plugin"
import type { NativeDecisionEvidenceRequest } from "../../missions/native-human-evidence"
import { isLocalNativeTool } from "../../missions/native-call-observation"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const formTag = Context.Service<never, unknown>("@opencode/Form")
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const same = (a: unknown, b: unknown) => canonicalAuthority(a, 256 * 1024) === canonicalAuthority(b, 256 * 1024)
const parse = (value: unknown): unknown => {
  if (typeof value !== "string" || Buffer.byteLength(value) > 256 * 1024) throw new Error("Native answer byte bound")
  return JSON.parse(value)
}
function passageInput(child: Readonly<RecurrenceChildRecord>) {
  const input = recurrenceInput(child), grant = child.grant
  for (const kind of ["create", "start", "coordinator-message"] as const) {
    const effects = child.effects.filter(record => record.effect.kind === kind), record = effects[0]
    if (effects.length !== 1 || record.operationID !== recurrenceEffectID(grant, record.effect)
      || record.receipt?.operationID !== record.operationID || record.receipt.outcome !== "applied"
      || record.receipt.evidenceID !== (kind === "coordinator-message" ? grant.messageID : grant.coordinatorSessionID)
      || record.effect.kind === "coordinator-message" && (record.effect.messageID !== grant.messageID
        || record.effect.contentDigest !== authorityDigest(input.text))) throw new Error("Native passage effect acknowledgement missing")
  }
  return input
}
type NativeDatabase = { db: { $client: SqlClient.SqlClient;
  transaction<A>(run: () => Effect.Effect<A, unknown>, options: { behavior: "immediate" }): Effect.Effect<A, unknown> } }
type NativeForms = { get(id: string): Effect.Effect<unknown, unknown>; state(id: string): Effect.Effect<unknown, unknown>;
  reply(input: { id: string; answer: Form.Answer }): Effect.Effect<void, unknown> }

/** Fixed RPC native graph, same per-profile private key and signed passage as
 * Play. No new key, HTTP auth store, session or user prompt. */
export const acquireNativeHumanAnswers = Effect.fn("missions.acquireNativeHumanAnswers")(function* (
  ctx: Pick<Plugin.Context, "location"> & Partial<Pick<Plugin.Context, "session" | "agent" | "model">>,
) {
  const database = yield* Effect.serviceOption(databaseTag), origin = yield* Effect.serviceOption(locationTag)
  const formService = yield* Effect.serviceOption(formTag)
  if (Option.isNone(database) || Option.isNone(origin) || Option.isNone(formService)) throw new Error("Native human answer graph unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const db = database.value as NativeDatabase, forms = formService.value as NativeForms
  if (!Predicate.isFunction(db.db?.$client) || !Predicate.isFunction(db.db.$client.unsafe) || !Predicate.isFunction(db.db.transaction)
    || !Predicate.isFunction(forms.get) || !Predicate.isFunction(forms.state) || !Predicate.isFunction(forms.reply)
    || !same({ directory: location.directory, workspaceID: location.workspaceID ?? null, project: location.project },
      { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID ?? null, project: ctx.location.project }))
    throw new Error("Native human answer contract unavailable")
  const graph = yield* Effect.context<never>()
  const query = (sql: string, args: readonly unknown[] = []) => db.db.$client.unsafe(sql, args).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const get = (key: string) => query("SELECT value FROM kv WHERE key=?", [nativeKey(key)]).pipe(Effect.map(result =>
    result[0]?.value === undefined ? undefined : parse(result[0].value)))
  const put = (key: string, value: unknown) => query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated",
    [nativeKey(key), canonicalAuthority(value, 256 * 1024), Date.now(), Date.now()])
  const file = (yield* query("PRAGMA database_list"))[0]?.file
  if (typeof file !== "string") throw new Error("Native storage identity unavailable")
  const storageID = nativeDatabaseStorageID(file)
  // Resolve once outside the IMMEDIATE frame; this shared fence still rereads
  // physical/config/discovery inputs at every check and retains Git fallback.
  const familyFence = yield* Effect.tryPromise(() => createFamilyAuthorityIdentityFence(location.directory))
  const placement = yield* Effect.sync(() => readFamilyAuthorityPlacementSync(location.directory))
  if (placement.family !== familyFence()) throw new Error("Native answer physical root changed")
  const current = () => {
    if (Context.get(graph, databaseTag) !== database.value || Context.get(graph, locationTag) !== origin.value
      || Context.get(graph, formTag) !== forms || nativeDatabaseStorageID(file) !== storageID) throw new Error("Native answer graph changed")
  }
  const session = (id: string) => query("SELECT id,parent_id,project_id,directory,workspace_id,metadata FROM session_v2 WHERE id=?", [id]).pipe(Effect.map(result => {
    const value = result[0]
    if (!value || value.id !== id || value.project_id !== location.project.id || value.directory !== location.directory
      || value.workspace_id !== (location.workspaceID ?? null)) throw new Error("Native answer session moved or foreign")
    return value
  }))
  const chain = (id: string) => Effect.gen(function* () {
    const seen = new Set<string>(), result = []
    for (let depth = 0; depth <= 32; depth++) {
      if (seen.has(id)) throw new Error("Native answer ancestry cycle")
      seen.add(id); const actual = yield* session(id); result.push(actual)
      if (actual.parent_id === null) return result
      if (typeof actual.parent_id !== "string") throw new Error("Native answer ancestry unknown")
      id = actual.parent_id
    }
    throw new Error("Native answer ancestry bound")
  })
  const signer = (profileID: string) => Effect.gen(function* () {
    const secret = yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${profileID}`)
    if (secret === undefined) return undefined
    if (typeof secret !== "string" || secret.length > 512) throw new Error("Native profile signer invalid")
    const privateKey = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" })
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Native profile signer invalid")
    const publicKey = createPublicKey(privateKey)
    return { privateKey, publicKey, signerDigest: authoritySignerDigest(publicKey) }
  })
  const delegation = (sessionID: string, call: { parentSessionID: string; parentMessageID: string; toolCallID: string }, live: boolean) => Effect.gen(function* () {
    const actor = yield* session(sessionID)
    yield* session(call.parentSessionID)
    const row = (yield* query("SELECT id,session_id,type,data FROM session_message WHERE id=?", [call.parentMessageID]))[0]
    const message = row && parse(row.data), content = object(message) && message.content
    const parts = Array.isArray(content) ? content.filter(part => object(part) && part.type === "tool" && part.id === call.toolCallID) : []
    const part = parts[0]
    if (actor.parent_id !== call.parentSessionID || !row || row.session_id !== call.parentSessionID || row.type !== "assistant"
      || parts.length !== 1 || !object(part) || !["subagent", "task"].includes(String(part.name)) || !isLocalNativeTool(part)
      || !object(part.state) || !object(part.state.metadata) || part.state.metadata.sessionID !== sessionID
      || live && part.state.status !== "running") throw new Error("Exact native decision delegation unavailable")
    return part
  })
  const oneTime = (input: { sessionID: string; formID: string; profileID: string; executionHost: string }, ancestry: Record<string, unknown>[], purpose: "reply" | "evidence") => Effect.gen(function* () {
    const prefix = nativeKey(`${MISSION_JOURNAL_STORAGE_PREFIX}/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/`)
    const rows = yield* query("SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key LIMIT 2001", [prefix.length, prefix])
    if (rows.length > 2000 || Buffer.byteLength(JSON.stringify(rows)) > 3 * 1024 * 1024) throw new Error("Ordinary human journal bound")
    const root = ancestry.at(-1)!
    const selected = yield* Effect.promise(() => selectOneTimeHumanTask({
      entries: rows.map(row => { if (typeof row.key !== "string") throw new Error("Ordinary human journal key invalid");
        return { key: row.key.slice(nativeKey("").length), value: parse(row.value) as import("../../missions/model").MissionJsonValue } }),
      projectID: location.project.id, projectCanonical: location.project.canonical, location,
      rootID: String(root.id), sessionID: input.sessionID, purpose,
    }))
    if (!selected) return null
    const { mission, task, call } = selected
    yield* delegation(input.sessionID, call, purpose === "reply")
    if (purpose === "reply") {
      if (!ctx.session || !ctx.agent || !ctx.model) throw new Error("Native decision profile capability unavailable")
      const actor = yield* ctx.session.get({ sessionID: Schema.decodeUnknownSync(Schema.toType(Session.ID))(input.sessionID) })
      if (actor.id !== input.sessionID || !matchesExecution(selected.execution, actor)
        || actor.location.directory !== location.directory || actor.location.workspaceID !== location.workspaceID)
        throw new Error("Ordinary decision profile changed")
      const agents = yield* ctx.agent.list({ location: { directory: location.directory } })
      const models = yield* ctx.model.list({ location: { directory: location.directory } })
      const agent = agents.data.find(candidate => candidate.id === actor.agent && !candidate.hidden)
      const model = models.data.find(candidate => candidate.providerID === actor.model?.providerID && candidate.id === actor.model.id)
      if (!agent || !["subagent", "all"].includes(agent.mode) || !model || !model.enabled || !model.capabilities.tools
        || actor.model?.variant && actor.model.variant !== "default" && !model.variants.some(variant => variant.id === actor.model!.variant))
        throw new Error("Ordinary decision profile refused")
    }
    const namespace = yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)
    if (typeof namespace !== "string" || !/^[a-f\d-]{36}$/.test(namespace)) throw new Error("Ordinary human namespace unavailable")
    const value = humanAnswerBindingSchema.parse({ sessionID: input.sessionID, formID: input.formID,
      profileID: input.profileID, executionHost: input.executionHost, mode: "one-time", missionID: mission.id,
      taskKey: task.key, generation: call.generation, nativeCall: call, coordinatorSessionID: mission.coordinatorSessionId,
      projectID: location.project.id, projectCanonical: location.project.canonical, namespace, daemonStorageID: storageID,
      location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) } })
    current()
    return { value, ...(yield* signer(input.profileID)), ancestry }
  })
  const lifecycle = (root: Record<string, unknown>, grant: RecurrenceChildGrant, text?: string, taskMode?: string) => Effect.gen(function* () {
    const metadata = parse(root.metadata), marker = object(metadata) && metadata["codenomad.mission"]
    if (root.id !== grant.coordinatorSessionID || !object(marker) || marker.version !== 1 || marker.kind !== "coordinator"
      || marker.role !== "coordinator" || marker.missionID !== grant.missionID) throw new Error("Native passage root mismatch")
    const row = (yield* query("SELECT id,session_id,type,data FROM session_message WHERE id=?", [grant.messageID]))[0]
    const message = row && parse(row.data), recorded = object(message) && message.metadata
    const mission = object(recorded) && recorded["codenomad.mission"]
    const recurrence = { grantID: grant.grantID, passageID: grant.passage.id, messageID: grant.messageID, coordinatorSessionID: root.id }
    if (!row || row.session_id !== root.id || row.type !== "synthetic" || !object(message) || !object(mission)
      || mission.version !== 1 || mission.missionID !== grant.missionID || mission.kind !== "lifecycle"
      || mission.operationID !== controlOperationID(grant.missionID, grant.passage.id) || !same(mission.recurrence, recurrence)
      || text !== undefined && message.text !== text || taskMode !== undefined && mission.taskMode !== taskMode)
      throw new Error("Original native passage message mismatch")
    const events = yield* query("SELECT id,seq,type,data FROM event WHERE aggregate_id=? AND type='session.inbox.enqueued.1' ORDER BY seq LIMIT 513", [root.id])
    if (events.length > 512) throw new Error("Native passage inbox bound")
    const exact = events.map(row => parse(row.data)).filter(data => object(data) && data.inboxID === grant.messageID)
    const event = exact[0], item = object(event) && event.item, payload = object(item) && item.payload
    if (exact.length !== 1 || !object(event) || event.sessionID !== root.id || !object(item) || item.type !== "synthetic"
      || !object(payload) || payload.text !== message.text || !same(payload.metadata, recorded))
      throw new Error("Original native passage admission mismatch")
    // An optional marker must agree, but the actual creator does NOT add it.
    if (marker.recurrence !== undefined && !same(marker.recurrence, recurrence)) throw new Error("Native passage marker mismatch")
  })
  const binding = (raw: unknown, purpose: "reply" | "evidence" = "reply") => Effect.gen(function* () {
    if (!object(raw)) throw new Error("Native answer request invalid")
    const input = humanAnswerBindingInputSchema.parse({ sessionID: raw.sessionID, formID: raw.formID,
      profileID: raw.profileID, executionHost: raw.executionHost }), ancestry = yield* chain(input.sessionID)
    const root = ancestry.at(-1)!
    const prefix = nativeKey(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/`)
    const entries = yield* query("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND substr(key,-5)='/live' LIMIT 65", [prefix.length, prefix])
    if (entries.length > 64) throw new Error("Native answer schedule bound")
    const candidates = entries.map(row => recurrenceAuthorityDocumentSchema.parse(parse(row.value)))
      .filter(doc => doc.child?.grant.coordinatorSessionID === root.id)
    if (!candidates.length) {
      const messages = yield* query("SELECT id,session_id,type,data FROM session_message WHERE session_id=? ORDER BY id LIMIT 129", [root.id])
      if (messages.length > 128) throw new Error("Native passage source bound")
      if (messages.some(row => {
        const message = parse(row.data), metadata = object(message) && message.metadata
        const marker = object(metadata) && metadata["codenomad.mission"]
        return object(marker) && marker.recurrence !== undefined
      })) throw new Error("Native passage ledger unavailable")
      return yield* oneTime(input, ancestry, purpose)
    }
    const matches = candidates.filter(doc => doc.scope.profileID === input.profileID && doc.scope.executionHost === input.executionHost)
    if (matches.length !== 1) throw new Error("Native answer passage unavailable")
    const doc = matches[0], child = doc.child!, parent = child.parent.body
    if (doc.scope.daemonStorageID !== storageID || !same(doc.parent, child.parent) || parent.action !== "authorize")
      throw new Error("Native answer passage mismatch")
    assertRecurrenceChild(child.parent, child.grant)
    yield* lifecycle(root, child.grant, passageInput(child).text, parent.config.taskMode)
    const secret = yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${input.profileID}`)
    if (typeof secret !== "string" || secret.length > 512) throw new Error("Native Play signer unavailable")
    const privateKey = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" })
    const publicKey = createPublicKey(privateKey), signerDigest = authoritySignerDigest(publicKey)
    authenticateRecurrenceStanding(child.parent, [{ ...parent, publicKey, policy: "codenomad.missions.authority/signed-v1", qualification: "qualified" }])
    const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, doc.scope)
    if (parent.signerDigest !== signerDigest || parent.provisioningGeneration !== signerDigest
      || !same(yield* get(`${authority.parentKey}/parents/${parent.epoch}`), child.parent)
      || (yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== doc.scope.namespace
      || (yield* get(`${authority.parentKey}/parents/${parent.epoch + 1}`)) !== undefined
      || (yield* get(`${authority.parentKey}/passages/${child.grant.passage.id}`)) !== undefined
      || !entries.some(entry => entry.key === nativeKey(authority.key) && same(parse(entry.value), doc))
      || Object.entries(doc.scope).some(([key, value]) => parent[key as keyof typeof parent] !== value))
      throw new Error("Native answer authority changed")
    for (const root of parent.roots) {
      const actual = root.directory === location.directory ? { family: familyFence(), checkout: placement.checkout }
        : readFamilyAuthorityPlacementSync(root.directory)
      if (root.mode !== "git" || actual.checkout !== root.checkout || actual.family !== root.family
        || physical(realpathSync(root.family)) !== root.family)
        throw new Error("Native answer physical root changed")
    }
    current()
    const value = humanAnswerBindingSchema.parse({ ...input, mode: "recurring", missionID: child.grant.missionID,
      coordinatorSessionID: root.id, scheduleID: doc.scope.scheduleID,
      passageID: child.grant.passage.id, grantID: child.grant.grantID, epoch: parent.epoch,
      projectID: location.project.id, projectCanonical: location.project.canonical,
      namespace: doc.scope.namespace, daemonStorageID: storageID,
      location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) } })
    return { value, privateKey, publicKey, signerDigest, ancestry }
  })
  const question = (sessionID: string, messageID: string, toolCallID: string) => Effect.gen(function* () {
    yield* session(sessionID)
    const message = (yield* query("SELECT id,session_id,type,data FROM session_message WHERE id=?", [messageID]))[0]
    const data = message && parse(message.data), content = object(data) && data.content
    const parts = Array.isArray(content) ? content.filter(part => object(part) && part.type === "tool" && part.id === toolCallID) : []
    const part = parts[0]
    if (!message || message.session_id !== sessionID || message.type !== "assistant" || parts.length !== 1
      || !object(part) || part.name !== "question" || !isLocalNativeTool(part) || !object(part.state) || !object(part.state.input))
      throw new Error("Native question call mismatch")
    const events = (yield* query("SELECT id,seq,type,data FROM event WHERE aggregate_id=? AND type IN ('session.tool.called.1','session.tool.success.2','session.tool.failed.2') ORDER BY seq LIMIT 513", [sessionID]))
    if (events.length > 512) throw new Error("Native question event bound")
    const exact = events.map(row => ({ id: row.id, seq: row.seq, type: row.type, data: parse(row.data) })).filter(event => object(event.data)
      && event.data.sessionID === sessionID && event.data.assistantMessageID === messageID && event.data.id === toolCallID)
    const called = exact.filter(event => event.type === "session.tool.called.1")
    if (called.length !== 1 || !object(called[0].data) || !isLocalNativeTool(called[0].data) || !same(called[0].data.input, part.state.input)
      || typeof called[0].id !== "string" || !Number.isSafeInteger(called[0].seq)) throw new Error("Native question call missing")
    return { part: { ...part, state: part.state }, input: part.state.input, profile: { agent: object(data) ? data.agent : undefined, model: object(data) ? data.model : undefined },
      called: { id: called[0].id, seq: called[0].seq as number },
      results: exact.filter(event => event.type !== "session.tool.called.1") }
  })
  const keyFor = (identity: string, projectID: string) => `${MISSION_AUTHORITY_STORAGE_PREFIX}/human-answers/${stableToken(projectID, 24)}/${identity}`
  const signRecord = (record: Omit<HumanAnswerReservation, "signature">, key: ReturnType<typeof createPrivateKey>): HumanAnswerReservation =>
    ({ ...record, signature: sign(null, humanAnswerSigningBytes(record), key).toString("base64") })
  const settledQuestion = (record: HumanAnswerReservation) => Effect.gen(function* () {
    const observed = yield* question(record.binding.sessionID, record.messageID, record.toolCallID)
    const answers = matchHumanQuestion(record.form, observed.input, record.answer), result = observed.results[0]
    if (!same(record.called, observed.called) || observed.part.state.status !== "completed" || observed.results.length !== 1
      || !result || result.type !== "session.tool.success.2" || !object(result.data) || !isLocalNativeTool(result.data)
      || !same(result.data.metadata, observed.part.state.metadata) || !object(observed.part.state.metadata)
      || !same(observed.part.state.metadata.answers, answers) || !same(result.data.content, observed.part.state.content)
      || typeof result.id !== "string" || !Number.isSafeInteger(result.seq) || Number(result.seq) <= record.called.seq) return undefined
    return { id: result.id, seq: result.seq as number }
  })
  /** Original authority/evidence only. This must NEVER borrow NEW reply/clock
   * admission, even after a denying epoch, Stop, or immutable child archival. */
  const receiptBinding = (input: import("zod").infer<typeof humanAnswerQuerySchema>) => Effect.gen(function* () {
    if (input.projectID !== location.project.id || input.projectCanonical !== location.project.canonical || input.daemonStorageID !== storageID
      || !same(input.location, { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) })
      || (yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== input.namespace) throw new Error("Native receipt storage mismatch")
    const signing = yield* signer(input.profileID)
    if (!signing) throw new Error("Native receipt signer missing")
    const ancestry = yield* chain(input.sessionID), root = ancestry.at(-1)!
    if (input.mode === "one-time") {
      const found = yield* oneTime(input, ancestry, "evidence")
      if (!found || !same(found.value, (({ workspaceID: _, ...rest }) => rest)(input))) throw new Error("Ordinary receipt binding mismatch")
    } else {
      const scope = { namespace: input.namespace, daemonStorageID: input.daemonStorageID, projectID: input.projectID,
        projectCanonical: input.projectCanonical, profileID: input.profileID, executionHost: input.executionHost, scheduleID: input.scheduleID }
      const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, scope)
      const archive = yield* get(`${authority.parentKey}/passages/${input.passageID}`)
      const hot = yield* get(authority.key)
      const live = hot === undefined ? undefined : recurrenceAuthorityDocumentSchema.parse(hot)
      const child = archive === undefined ? live?.child : recurrenceAuthorityArchiveSchema.parse(archive).child
      if (!child || live && !same(live.scope, scope) || child.grant.grantID !== input.grantID || child.grant.passage.id !== input.passageID
        || child.parent.body.epoch !== input.epoch || child.grant.coordinatorSessionID !== input.coordinatorSessionID || child.grant.missionID !== input.missionID
        || !same(yield* get(`${authority.parentKey}/parents/${input.epoch}`), child.parent)
        || Object.entries(scope).some(([key, value]) => child.parent.body[key as keyof typeof child.parent.body] !== value))
        throw new Error("Original native receipt authority unavailable")
      authenticateRecurrenceStanding(child.parent, [{ ...child.parent.body, publicKey: signing.publicKey,
        policy: "codenomad.missions.authority/signed-v1", qualification: "qualified" }])
      assertRecurrenceChild(child.parent, child.grant)
      for (const root of child.parent.body.roots) {
        const actual = root.directory === location.directory ? { family: familyFence(), checkout: placement?.checkout } : readFamilyAuthorityPlacementSync(root.directory)
        if (root.mode !== "git" || actual.checkout !== root.checkout || actual.family !== root.family
          || physical(realpathSync(root.family)) !== root.family) throw new Error("Native receipt physical root changed")
      }
      yield* lifecycle(root, child.grant, passageInput(child).text, child.parent.body.config.taskMode)
    }
    current(); return { ...signing, ancestry }
  })
  const reconcile = (raw: unknown) => Effect.gen(function* () {
    const input = humanAnswerQuerySchema.parse(raw), found = yield* receiptBinding(input)
    const identity = humanAnswerIdentity(input), key = keyFor(identity, input.projectID)
    const stored = yield* get(key)
    if (!object(stored)) throw new Error("Native human answer reservation missing")
    const record = stored as unknown as HumanAnswerReservation
    verifyHumanAnswerSignature(record, found.publicKey)
    if (!same(record.binding, input) || record.identity !== identity) throw new Error("Native receipt identity mismatch")
    if (record.state === "reserved") return { status: "pending" as const, identity, record, ancestry: found.ancestry }
    const answered = yield* settledQuestion(record)
    if (!answered) return { status: "replied" as const, identity, record, ancestry: found.ancestry }
    if (record.state === "settled" && !same(record.answered, answered)) throw new Error("Native answer result changed")
    if (record.state !== "settled") {
      const { signature: _, ...body } = record
      const next = signRecord({ ...body, state: "settled", answered }, found.privateKey)
      if (!same(yield* get(key), record)) throw new Error("Native answer reconciliation changed")
      yield* put(key, next); current()
      return { status: "settled" as const, identity, record: next, ancestry: found.ancestry }
    }
    return { status: "settled" as const, identity, record, ancestry: found.ancestry }
  })
  const api = {
    binding: async (raw: unknown) => {
      const input = humanAnswerBindingInputSchema.parse(raw)
      const prefix = nativeKey(`${MISSION_AUTHORITY_STORAGE_PREFIX}/human-answers/${stableToken(location.project.id, 24)}/`)
      const rows = await run(query("SELECT value FROM kv WHERE substr(key,1,?)=? LIMIT 257", [prefix.length, prefix]))
      if (rows.length > 256) throw new Error("Native human receipt lookup bound")
      const records = rows.map(row => parse(row.value) as HumanAnswerReservation).filter(record => record.binding?.sessionID === input.sessionID
        && record.binding.formID === input.formID && record.binding.profileID === input.profileID && record.binding.executionHost === input.executionHost)
      if (records.length > 1) throw new Error("Native human receipt lookup ambiguous")
      if (records.length) {
        const record = records[0]
        const found = await run(receiptBinding(humanAnswerQuerySchema.parse(record.binding)))
        verifyHumanAnswerSignature(record, found.publicKey)
        if (record.identity !== humanAnswerIdentity(record.binding)) throw new Error("Native human receipt lookup identity mismatch")
        return (({ workspaceID: _, ...value }) => value)(record.binding)
      }
      return run(binding(input).pipe(Effect.map(found => found?.value ?? null)))
    },
    reconcile: (input: unknown) => run(db.db.transaction(() => reconcile(input), { behavior: "immediate" }).pipe(
      Effect.map(({ status, identity }) => ({ status, identity })))),
    /** Native business-report verifier consumer. `target` is selected from the
     * owned passage capability, never a model artifact. Historical receipts do
     * not borrow live send privilege or depend on the Form's ten-minute cache. */
    humanGate: async (target: unknown, request: NativeDecisionEvidenceRequest): Promise<HumanAnswerReservation> => {
      humanDecisionRequestSchema.parse(request)
      const input = humanAnswerQuerySchema.parse(target)
      return run(db.db.transaction(() => Effect.gen(function* () {
        const observed = yield* reconcile(input), record = observed.record, ancestry = observed.ancestry, root = ancestry.at(-1)!
        if (observed.status !== "settled") throw new Error("Human answer receipt unavailable")
        if (input.mode === "one-time") {
          if (input.taskKey !== request.contract.taskKey || input.generation !== request.contract.generation
            || !same(input.nativeCall, request.nativeCall)) throw new Error("Ordinary human receipt task provenance mismatch")
        }
        const field = record.form.fields.find(field => field.key === request.fieldKey)
        if (root.id !== input.coordinatorSessionID || request.projectID !== input.projectID || request.directory !== input.location.directory
          || request.sessionID !== input.sessionID || request.formID !== input.formID || request.messageID !== record.messageID
          || request.toolCallID !== record.toolCallID || field?.description !== request.question
          || !same(record.answer[request.fieldKey], request.answer))
          throw new Error("Human answer provenance mismatch")
        if (ancestry[0].parent_id !== request.nativeCall.parentSessionID || request.nativeCall.generation !== request.contract.generation
          || input.missionID !== request.contract.missionID) throw new Error("Human decision invocation mismatch")
        yield* session(request.nativeCall.parentSessionID)
        const delegation = (yield* query("SELECT id,session_id,type,data FROM session_message WHERE id=?", [request.nativeCall.parentMessageID]))[0]
        const parentData = delegation && parse(delegation.data), content = object(parentData) && parentData.content
        const calls = Array.isArray(content) ? content.filter(part => object(part) && part.type === "tool" && part.id === request.nativeCall.toolCallID) : []
        const call = calls[0]
        if (!delegation || delegation.session_id !== request.nativeCall.parentSessionID || delegation.type !== "assistant"
          || calls.length !== 1 || !object(call) || call.name !== request.delegationToolName || !isLocalNativeTool(call)
          || !object(call.state) || !object(call.state.metadata) || call.state.metadata.sessionID !== input.sessionID)
          throw new Error("Human decision native delegation mismatch")
        current(); return structuredClone(record)
      }), { behavior: "immediate" }))
    },
    /** Fixed native report consumer: exact stored Form/session and native call,
     * never an `approved` artifact, model text or a caller-provided receipt. */
    verify: async (raw: unknown): Promise<HumanAnswerReservation> => {
      const request = humanDecisionRequestSchema.parse(raw)
      if (request.projectID !== location.project.id || request.directory !== location.directory) throw new Error("Human decision Location mismatch")
      const prefix = nativeKey(`${MISSION_AUTHORITY_STORAGE_PREFIX}/human-answers/${stableToken(location.project.id, 24)}/`)
      const candidates = await run(query("SELECT value FROM kv WHERE substr(key,1,?)=? LIMIT 257", [prefix.length, prefix]))
      if (candidates.length > 256) throw new Error("Human receipt read bound")
      const matches = candidates.map(row => parse(row.value) as HumanAnswerReservation).filter(record =>
        record.binding?.sessionID === request.sessionID && record.binding.formID === request.formID)
      if (matches.length !== 1) throw new Error("Exact native human receipt unavailable")
      return api.humanGate(matches[0].binding, request)
    },
    reply: async (raw: unknown) => {
      const input = humanAnswerRpcInputSchema.parse(raw), body = input.body
      if (!await verifyHumanAnswerBridge(body, input.proof)) throw new Error("Human answer authentication unavailable")
      const { cookieSessionID, username, issuedAt: _, answer, ...target } = body
      const identity = humanAnswerIdentity(target), key = keyFor(identity, target.projectID)
      const reserved = await run(db.db.transaction(() => Effect.gen(function* () {
        assertHumanAnswerFresh(body)
        const old = yield* get(key)
        if (old !== undefined) {
          const found = yield* receiptBinding(target)
          const record = old as HumanAnswerReservation; verifyHumanAnswerSignature(record, found.publicKey)
          if (!same(record.binding, target) || !same(record.answer, answer)) throw new Error("Human answer retry changed")
          return false // Receipt-only reconciliation; NEVER another Form.reply.
        }
        const found = yield* binding(target)
        if (!found || !same(found.value, (({ workspaceID: _, ...rest }) => rest)(target))) throw new Error("Human answer binding mismatch")
        const form = yield* Schema.decodeUnknownEffect(Schema.toType(Form.Info))(yield* forms.get(body.formID))
        const state = yield* Schema.decodeUnknownEffect(Schema.toType(Form.State))(yield* forms.state(body.formID))
        const tool = form.metadata?.tool
        if (state.status !== "pending" || form.sessionID !== body.sessionID || !object(tool)
          || typeof tool.messageID !== "string" || typeof tool.id !== "string") throw new Error("Exact pending question unavailable")
        const observed = yield* question(body.sessionID, tool.messageID, tool.id)
        if (observed.part.state.status !== "running" || observed.results.length) throw new Error("Question already settled")
        matchHumanQuestion(form, observed.input, answer)
        if (body.mode === "one-time") {
          if (!ctx.session || typeof observed.profile.agent !== "string" || !object(observed.profile.model))
            throw new Error("Ordinary question execution profile missing")
          const actor = yield* ctx.session.get({ sessionID: Schema.decodeUnknownSync(Schema.toType(Session.ID))(body.sessionID) })
          if (!matchesExecution(observed.profile as import("../../missions/execution").MissionExecution, actor))
            throw new Error("Ordinary question execution profile changed")
          // First native human answer may provision the SAME profile key, only
          // here: authenticated proof + exact pending accepted question + native CAS.
          if ((yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${body.profileID}`)) === undefined) {
            const secret = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
            yield* query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING",
              [nativeKey(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${body.profileID}`), JSON.stringify(secret), Date.now(), Date.now()])
          }
        }
        const signing = yield* signer(body.profileID)
        if (!signing) throw new Error("Native human signer missing")
        const record = signRecord({ version: 1, identity, binding: target,
          principal: { kind: "codenomad-human", sessionDigest: authorityDigest({ cookieSessionID }), username },
          form, answer, messageID: tool.messageID, toolCallID: tool.id, called: observed.called,
          state: "reserved", signerDigest: signing.signerDigest }, signing.privateKey)
        // ponytail: 256 receipts per project; retain old proofs, refuse overflow rather than deleting provenance.
        const prefix = nativeKey(`${MISSION_AUTHORITY_STORAGE_PREFIX}/human-answers/${stableToken(target.projectID, 24)}/`)
        const count = (yield* query("SELECT count(*) AS count FROM kv WHERE substr(key,1,?)=?", [prefix.length, prefix]))[0]?.count
        if (typeof count !== "number" || count >= 256) throw new Error("Native human answer receipt capacity")
        assertHumanAnswerFresh(body)
        yield* put(key, record); current(); assertHumanAnswerFresh(body); return true
      }), { behavior: "immediate" }))
      if (!reserved) return api.reconcile(target)
      // The SAME private bridge checks the live AuthManager session again after
      // durable reservation. Failure leaves the original identity pending.
      if (!await verifyHumanAnswerBridge(body, input.proof)) throw new Error("Human answer authentication changed")
      await run(db.db.transaction(() => Effect.gen(function* () {
        const found = yield* binding(target), record = (yield* get(key)) as HumanAnswerReservation
        if (!found || !same(record.binding, target) || record.state !== "reserved") throw new Error("Human answer reservation changed")
        if (!found.publicKey) throw new Error("Native human signer missing")
        verifyHumanAnswerSignature(record, found.publicKey)
        const form = yield* Schema.decodeUnknownEffect(Schema.toType(Form.Info))(yield* forms.get(body.formID))
        const state = yield* Schema.decodeUnknownEffect(Schema.toType(Form.State))(yield* forms.state(body.formID))
        if (state.status !== "pending" || !same(form, record.form)) throw new Error("Human answer Form changed")
        // The native IMMEDIATE frame excludes session/grant/epoch writers through
        // reply and witness publication. Native Form.reply only publishes to the
        // volatile bus/cache/deferred, not SQLite (core/src/form.ts v2.0.24).
        const finalBinding = yield* binding(target)
        if (!finalBinding?.privateKey || !same(finalBinding.value, found.value) || !same(finalBinding.ancestry, found.ancestry))
          throw new Error("Human answer native admission changed")
        yield* Effect.suspend(() => { current(); assertHumanAnswerFresh(body); return forms.reply({ id: body.formID, answer }) })
        // Positive native return + actual settled native state, not proxy ACK.
        const settled = yield* Schema.decodeUnknownEffect(Schema.toType(Form.State))(yield* forms.state(body.formID))
        if (settled.status !== "answered" || !same(settled.answer, record.answer)) throw new Error("Human answer outcome unknown")
        if (!same(yield* get(key), record)) throw new Error("Human answer outcome changed")
        const { signature: _, ...value } = record
        yield* put(key, signRecord({ ...value, state: "replied" }, finalBinding.privateKey)); current()
      }), { behavior: "immediate" }))
      return api.reconcile(target)
    },
  }
  return api
})
