import { randomUUID } from "node:crypto"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Form } from "@opencode/schema/form"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { stableToken } from "../../missions/journal"
import { humanAnswerBindingInputSchema, humanAnswerBindingSchema, humanAnswerRpcInputSchema,
  humanDecisionRequestSchema, assertHumanAnswerFresh, matchHumanQuestion,
  type HumanDecisionMark } from "../../missions/human-answer"
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
type NativeForms = { get(id: string): Effect.Effect<unknown, unknown>; state(id: string): Effect.Effect<unknown, unknown>;
  reply(input: { id: string; answer: Form.Answer }): Effect.Effect<void, unknown> }

/** Authenticated UI marks, independent of one-time/recurring scheduling.
 * verify(request): Promise<HumanDecisionMark> retains exact native binding checks. */
export const acquireNativeHumanAnswers = Effect.fn("missions.acquireNativeHumanAnswers")(function* (
  ctx: Pick<Plugin.Context, "location">,
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
  const keyFor = (sessionID: string, formID: string) => `${MISSION_AUTHORITY_STORAGE_PREFIX}/human-marks/${stableToken(`${location.project.id}\0${location.project.canonical}`, 24)}/${sessionID}/${formID}`
  const api = {
    binding: async (raw: unknown) => {
      const input = humanAnswerBindingInputSchema.parse(raw)
      await run(session(input.sessionID)); current()
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
    reply: async (raw: unknown) => {
      const input = humanAnswerRpcInputSchema.parse(raw), body = input.body
      if (!await verifyHumanAnswerBridge(body, input.proof)) throw new Error("Human answer authentication unavailable")
      const binding = await api.binding({ sessionID: body.sessionID, formID: body.formID, profileID: body.profileID, executionHost: body.executionHost })
      if (!same(binding, (({ workspaceID: _, cookieSessionID: _cookie, username: _user, issuedAt: _time, answer: _answer, ...target }) => target)(body)))
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
