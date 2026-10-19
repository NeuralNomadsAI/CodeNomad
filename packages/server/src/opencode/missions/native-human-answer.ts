import { randomUUID } from "node:crypto"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Form } from "@opencode/schema/form"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { MISSION_JOURNAL_STORAGE_PREFIX, MissionJournal, stableToken, type MissionStorage } from "../../missions/journal"
import { HUMAN_MARK_STORAGE_PREFIX, humanAnswerBindingInputSchema, humanAnswerBindingSchema, humanAnswerRpcInputSchema,
  humanDecisionDiscoverySchema, humanDecisionRequestSchema, assertHumanAnswerFresh, matchHumanQuestion,
  type HumanDecisionCandidate, type HumanDecisionDiscovery, type HumanDecisionMark, type NativeHumanAnswerGate } from "../../missions/human-answer"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { verifyHumanAnswerBridge } from "../automation-plugin"
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
type NativeDatabase = { db: { $client: SqlClient.SqlClient;
  transaction<A>(run: () => Effect.Effect<A, unknown>, options: { behavior: "immediate" }): Effect.Effect<A, unknown> } }
type StoredMark = HumanDecisionMark & { state: "pending" | "confirmed"; attemptID: string }
/** Discovery bounds: a decision task's own children, marks per child and returned answers. */
const MAX_DISCOVERED_CHILDREN = 64
const MAX_DISCOVERED_MARKS = 16
const MAX_DISCOVERED_ANSWERS = 16
const MAX_DELEGATION_MESSAGES = 8
type NativeForms = { get(id: string): Effect.Effect<unknown, unknown>; state(id: string): Effect.Effect<unknown, unknown>;
  reply(input: { id: string; answer: Form.Answer }): Effect.Effect<void, unknown> }
type AnswerReadRunner = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>

/** Authenticated UI marks, independent of one-time/recurring scheduling.
 * verify(request): Promise<HumanDecisionMark> retains exact native binding checks. */
export const acquireNativeHumanAnswers = Effect.fn("missions.acquireNativeHumanAnswers")(function* (
  ctx: Pick<Plugin.Context, "location"> & Partial<Pick<Plugin.Context, "storage">>,
  read?: AnswerReadRunner,
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
  // One-time gates supply their invoking runner: nested SQL/Form/storage reads
  // must share its signal, deadline and join, not start detached runtimes.
  const run: AnswerReadRunner = read ?? (effect => Effect.runPromise(effect.pipe(Effect.provide(graph))))
  const get = (key: string) => query("SELECT value FROM kv WHERE key=?", [nativeKey(key)]).pipe(Effect.map(result =>
    result[0]?.value === undefined ? undefined : parse(result[0].value)))
  const put = (key: string, value: unknown) => query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated",
    [nativeKey(key), canonicalAuthority(value, 256 * 1024), Date.now(), Date.now()])
  const file = (yield* query("PRAGMA database_list"))[0]?.file
  if (typeof file !== "string") throw new Error("Native storage identity unavailable")
  const storageID = nativeDatabaseStorageID(file)
  const current = () => {
    if (Context.get(graph, databaseTag) !== database.value || Context.get(graph, locationTag) !== origin.value
      || Context.get(graph, formTag) !== forms || nativeDatabaseStorageID(file) !== storageID) throw new Error("Native answer graph changed")
  }
  const session = (id: string) => query("SELECT id,parent_id,project_id,directory,workspace_id FROM session_v2 WHERE id=?", [id]).pipe(Effect.map(result => {
    const value = result[0]
    // Native SQL stores slash-separated Windows paths; the Location graph uses host separators.
    if (!value || value.id !== id || value.project_id !== location.project.id || typeof value.directory !== "string"
      || path.normalize(value.directory) !== path.normalize(location.directory)
      || value.workspace_id !== (location.workspaceID ?? null)) throw new Error("Native answer session moved or foreign")
    return value
  }))
  const question = (sessionID: string, messageID: string, toolCallID: string, name = "question") => Effect.gen(function* () {
    yield* session(sessionID)
    const message = (yield* query("SELECT id,session_id,type,data FROM session_message WHERE id=?", [messageID]))[0]
    const data = message && parse(message.data), content = object(data) && data.content
    const parts = Array.isArray(content) ? content.filter(part => object(part) && part.type === "tool" && part.id === toolCallID) : []
    const part = parts[0]
    if (!message || message.session_id !== sessionID || message.type !== "assistant" || parts.length !== 1
      || !object(part) || part.name !== name || !isLocalNativeTool(part) || !object(part.state) || !object(part.state.input))
      throw new Error("Native question call mismatch")
    return { ...part, state: part.state, input: part.state.input }
  })
  const keyFor = (sessionID: string, formID: string) => `${HUMAN_MARK_STORAGE_PREFIX}/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/${sessionID}/${formID}`
  /** Exact durable membership of a metadata-less root: the native parent chain
   * from the Form's session ends at exactly this root, and that root is the
   * coordinator actor of a Mission in this project's one-time journal. Bounded
   * ancestry and the bounded journal only; no title, list or transcript scans. */
  const journalCoordinator = async (sessionID: string, root: string) => {
    let id = sessionID
    for (let depth = 0; ; depth++) {
      const row = await run(session(id))
      if (row.parent_id === null || row.parent_id === undefined) { if (id !== root) return false; break }
      if (depth >= 32 || typeof row.parent_id !== "string") return false
      id = row.parent_id
    }
    // Bounded exact-identity probe first: a root whose ID appears nowhere in this
    // project's journal values cannot be any Mission's coordinator, so ordinary
    // conversations never pay the full journal read. Only a match (or an ID whose
    // JSON form could be escaped) proceeds to the exact snapshot membership below.
    if (/^[A-Za-z0-9_-]{1,256}$/.test(root)) {
      const prefix = nativeKey(`${MISSION_JOURNAL_STORAGE_PREFIX}/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/`)
      const hit = await run(query("SELECT 1 AS hit FROM kv WHERE key>=? AND key<? AND instr(value,?)>0 LIMIT 1",
        [prefix, `${prefix.slice(0, -1)}0`, JSON.stringify(root)]))
      if (!hit.length) return false
    }
    if (!ctx.storage) throw new Error("Native Mission journal unavailable")
    const storage = ctx.storage
    const journal = new MissionJournal({ get: key => run(storage.get(key)) as ReturnType<MissionStorage["get"]>,
      scan: options => run(storage.scan(options)) as ReturnType<MissionStorage["scan"]>,
      set: async () => { throw new Error("Human answer membership is read-only") } }, location.project.id, location.project.canonical)
    const snapshot = await journal.snapshot()
    return snapshot.missions.some(mission => mission.actors.some(actor => actor.sessionId === root && actor.kind === "coordinator"))
  }
  const api = {
    binding: async (raw: unknown) => {
      const { rootSessionID, ...input } = humanAnswerBindingInputSchema.parse(raw)
      await run(session(input.sessionID)); current()
      if (rootSessionID !== undefined && !await journalCoordinator(input.sessionID, rootSessionID)) return null
      current()
      return humanAnswerBindingSchema.parse({ ...input, projectID: location.project.id,
        location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) } })
    },
    verify: async (raw: unknown): Promise<HumanDecisionMark> => {
      const request = humanDecisionRequestSchema.parse(raw)
      if (request.projectID !== location.project.id || request.directory !== location.directory) throw new Error("Human decision Location mismatch")
      return run(db.db.transaction(() => Effect.gen(function* () {
        const stored = yield* get(keyFor(request.sessionID, request.formID))
        // Pending (unconfirmed or uncertain) attempts never qualify.
        if (!object(stored) || stored.state !== "confirmed" || stored.via !== "ui" || stored.formID !== request.formID
          || stored.sessionID !== request.sessionID || !Number.isSafeInteger(stored.answeredAt)) throw new Error("Exact native human mark unavailable")
        const { state: _state, attemptID: _attempt, ...mark } = stored as unknown as StoredMark
        const form = Schema.decodeUnknownSync(Schema.toType(Form.Info))(mark.form)
        const tool = form.metadata?.tool
        if (form.id !== request.formID || form.sessionID !== request.sessionID || !object(tool)
          || tool.messageID !== request.messageID || tool.id !== request.toolCallID) throw new Error("Human mark Form binding mismatch")
        const actor = yield* session(request.sessionID)
        const delegation = yield* question(request.nativeCall.parentSessionID, request.nativeCall.parentMessageID,
          request.nativeCall.toolCallID, request.delegationToolName)
        if (actor.parent_id !== request.nativeCall.parentSessionID || !object(delegation.state.metadata)
          || delegation.state.metadata.sessionID !== request.sessionID) throw new Error("Human decision native delegation mismatch")
        // Without a published binding, only a fresh child born from this exact declared
        // assignment qualifies; a continuation reuses a child born for other work.
        if (request.assignmentPrompt !== undefined && (delegation.input.sessionID !== undefined
          || typeof delegation.input.prompt !== "string" || !delegation.input.prompt.includes(request.assignmentPrompt)))
          throw new Error("Human decision delegation is not this assignment")
        // The durable message projection is the native record of the answered call:
        // `serve` (2.0.26) does not persist Bus events, so the event table stays empty.
        const observed = yield* question(request.sessionID, request.messageID, request.toolCallID)
        const answers = matchHumanQuestion(form, observed.input, mark.answer)
        if (observed.state.status !== "completed" || !object(observed.state.metadata) || !same(observed.state.metadata.answers, answers)
          || form.fields.find(field => field.key === request.fieldKey)?.description !== request.question
          || !same(mark.answer[request.fieldKey], request.answer)) throw new Error("Human decision answer mismatch")
        // Only explicit cache absence uses the saved Form snapshot. Other native
        // read failures remain failures; a pending/cancelled Form never qualifies.
        const cached = yield* forms.get(request.formID).pipe(Effect.catchIf(error => object(error) && error._tag === "Form.NotFoundError", () => Effect.succeed(undefined)))
        if (cached !== undefined) {
          const state = Schema.decodeUnknownSync(Schema.toType(Form.State))(yield* forms.state(request.formID))
          if (!same(cached, form) || state.status !== "answered" || !same(state.answer, mark.answer)) throw new Error("Native Form not answered")
        }
        current(); return structuredClone(mark)
      }), { behavior: "immediate" }))
    },
    /** Exact native structure only: a child of the expected parent whose fresh `subagent`
     * call carried this assignment, its confirmed UI marks, and the gate's own verify.
     * Nothing is inferred from text, titles, timing or the model's assertion. */
    discover: async (raw: unknown): Promise<HumanDecisionDiscovery> => {
      const request = humanDecisionDiscoverySchema.parse(raw)
      if (request.projectID !== location.project.id || request.directory !== location.directory) throw new Error("Human decision Location mismatch")
      const candidates: HumanDecisionCandidate[] = []
      // Every bound reached or unverifiable confirmed answer leaves the discovery incomplete.
      let complete = true
      const bounded = <T>(rows: readonly T[], limit: number) => { if (rows.length > limit) complete = false; return rows.slice(0, limit) }
      const children = bounded(await run(query("SELECT id FROM session_v2 WHERE parent_id=? AND project_id=? ORDER BY id LIMIT ?",
        [request.parentSessionID, location.project.id, MAX_DISCOVERED_CHILDREN + 1])), MAX_DISCOVERED_CHILDREN)
      for (const child of children) {
        if (typeof child.id !== "string") { complete = false; continue }
        const messages = bounded(await run(query("SELECT id,data FROM session_message WHERE session_id=? AND type='assistant' AND instr(data,?)>0 LIMIT ?",
          [request.parentSessionID, JSON.stringify(child.id), MAX_DELEGATION_MESSAGES + 1])), MAX_DELEGATION_MESSAGES)
        let call: { parentMessageID: string; toolCallID: string } | undefined
        for (const message of messages) {
          const data = parse(message.data), content = object(data) && Array.isArray(data.content) ? data.content : []
          const part = content.find(part => object(part) && part.type === "tool" && part.name === "subagent" && isLocalNativeTool(part)
            && object(part.state) && object(part.state.metadata) && part.state.metadata.sessionID === child.id && object(part.state.input)
            && part.state.input.sessionID === undefined && typeof part.state.input.prompt === "string"
            && part.state.input.prompt.includes(request.assignmentPrompt))
          if (object(part) && typeof message.id === "string" && typeof part.id === "string") { call = { parentMessageID: message.id, toolCallID: part.id }; break }
        }
        if (!call) continue
        const prefix = nativeKey(`${HUMAN_MARK_STORAGE_PREFIX}/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/${child.id}/`)
        const marks = bounded(await run(query("SELECT value FROM kv WHERE key>=? AND key<? LIMIT ?",
          [prefix, `${prefix.slice(0, -1)}0`, MAX_DISCOVERED_MARKS + 1])), MAX_DISCOVERED_MARKS)
        for (const row of marks) {
          const stored = (() => { try { return parse(row.value) } catch { return undefined } })()
          const form = (() => { try { return Schema.decodeUnknownSync(Schema.toType(Form.Info))(object(stored) ? stored.form : undefined) } catch { return undefined } })()
          // Answers to other kinds of Forms are not decision candidates.
          if (form && form.metadata?.kind !== "question") continue
          const tool = form?.metadata?.tool
          // A pending attempt never qualifies but its outcome is unknown; an unreadable or
          // mis-bound confirmed mark cannot be excluded either. Both leave discovery incomplete.
          if (!object(stored) || stored.state !== "confirmed" || stored.via !== "ui" || stored.sessionID !== child.id || !object(stored.answer)
            || !form || !object(tool) || typeof tool.messageID !== "string" || typeof tool.id !== "string") { complete = false; continue }
          for (const field of form.fields) {
            const answer = stored.answer[field.key]
            if (typeof field.description !== "string" || !(typeof answer === "string" && answer
              || Array.isArray(answer) && answer.length && answer.every(item => typeof item === "string" && item))) continue
            const provenance = { kind: "native-form-answer" as const, contract: request.contract,
              nativeCall: { generation: request.contract.generation, parentSessionID: request.parentSessionID, ...call },
              sessionID: child.id, formID: form.id, messageID: tool.messageID, toolCallID: tool.id, fieldKey: field.key }
            try {
              await api.verify({ ...provenance, question: field.description, answer, projectID: request.projectID, directory: request.directory,
                delegationToolName: "subagent", assignmentPrompt: request.assignmentPrompt })
            } catch { complete = false; continue }
            if (candidates.length >= MAX_DISCOVERED_ANSWERS) return { candidates, complete: false }
            const value = answer as string | string[]
            candidates.push({ question: field.description, answer: value, artifact: { kind: "decision", question: field.description, answer: value, provenance } })
          }
        }
      }
      return { candidates, complete }
    },
    reply: async (raw: unknown) => {
      const input = humanAnswerRpcInputSchema.parse(raw), body = input.body
      if (!await verifyHumanAnswerBridge(body, input.proof)) throw new Error("Human answer authentication unavailable")
      const binding = await api.binding({ sessionID: body.sessionID, formID: body.formID, profileID: body.profileID, executionHost: body.executionHost })
      if (!binding || !same(binding, (({ workspaceID: _, principal: _principal, username: _user, issuedAt: _time, answer: _answer, ...target }) => target)(body)))
        throw new Error("Human answer binding mismatch")
      const key = keyFor(body.sessionID, body.formID), attemptID = randomUUID()
      const expectedForm = await run(db.db.transaction(() => Effect.gen(function* () {
        assertHumanAnswerFresh(body); yield* session(body.sessionID)
        const form = Schema.decodeUnknownSync(Schema.toType(Form.Info))(yield* forms.get(body.formID))
        const state = Schema.decodeUnknownSync(Schema.toType(Form.State))(yield* forms.state(body.formID))
        if (state.status !== "pending" || form.id !== body.formID || form.sessionID !== body.sessionID) throw new Error("Exact pending Form unavailable")
        if (form.metadata?.kind === "question") {
          const tool = form.metadata.tool
          if (!object(tool) || typeof tool.messageID !== "string" || typeof tool.id !== "string") throw new Error("Native question binding unavailable")
          const observed = yield* question(body.sessionID, tool.messageID, tool.id)
          if (observed.state.status !== "running") throw new Error("Question already settled")
          matchHumanQuestion(form, observed.input, body.answer)
        }
        const mark: StoredMark = { formID: body.formID, sessionID: body.sessionID, answeredAt: Date.now(), via: "ui", form, answer: body.answer,
          state: "pending", attemptID }
        const old = yield* get(key)
        // The native Form is still pending inside this transaction, so an
        // earlier unconfirmed attempt did not land and its mark is replaced.
        if (old !== undefined && (!object(old) || old.state !== "pending")) throw new Error("Human answer already recorded")
        // Write-ahead pending mark: it never qualifies until this exact
        // attempt's native reply returns positively and promotes it.
        yield* put(key, mark)
        current(); assertHumanAnswerFresh(body)
        return form
      }), { behavior: "immediate" }))
      const settle = (confirmed: boolean) => run(db.db.transaction(() => Effect.gen(function* () {
        const stored = yield* get(key)
        if (!object(stored) || stored.state !== "pending" || stored.attemptID !== attemptID) return
        if (confirmed) { yield* put(key, { ...stored, state: "confirmed" }); return }
        // Only a Form still observed pending proves the reply did not land;
        // any other or unreadable state leaves the attempt uncertain (pending).
        const state = Schema.decodeUnknownSync(Schema.toType(Form.State))(yield* forms.state(body.formID))
        if (state.status === "pending") yield* query("DELETE FROM kv WHERE key=?", [nativeKey(key)])
      }), { behavior: "immediate" }))
      try {
        if (!await verifyHumanAnswerBridge(body, input.proof)) throw new Error("Human answer authentication changed")
        await run(Effect.gen(function* () {
          yield* session(body.sessionID)
          const form = yield* forms.get(body.formID)
          const state = Schema.decodeUnknownSync(Schema.toType(Form.State))(yield* forms.state(body.formID))
          if (!same(form, expectedForm) || state.status !== "pending") throw new Error("Human answer Form changed")
          current(); assertHumanAnswerFresh(body)
          yield* forms.reply({ id: body.formID, answer: body.answer })
        }))
      } catch (error) {
        await settle(false).catch(() => undefined)
        throw error
      }
      // A failed promotion leaves the mark pending: the gate stays unmet rather
      // than reporting a native reply that did land as failed.
      await settle(true).catch(() => undefined)
      return { status: "answered" as const }
    },
  }
  return api
})
export type NativeHumanAnswers = Effect.Success<ReturnType<typeof acquireNativeHumanAnswers>>

/** The control-facing gate; `withAnswers` acquires one native answer graph per call. */
export function nativeHumanAnswerGate(withAnswers: <A>(use: (answers: NativeHumanAnswers) => Promise<A>) => Promise<A>): NativeHumanAnswerGate {
  return Object.assign((request: Parameters<NativeHumanAnswerGate>[0]) => withAnswers(answers => answers.verify(request)),
    { discover: (request: Parameters<NonNullable<NativeHumanAnswerGate["discover"]>>[0]) => withAnswers(answers => answers.discover(request)) })
}
