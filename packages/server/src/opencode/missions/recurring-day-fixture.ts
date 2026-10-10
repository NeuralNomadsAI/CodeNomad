import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import Fastify from "fastify"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Form } from "@opencode/schema/form"
import { Clock, Context, Duration, Effect, Exit, Fiber, RcMap, Schema, Scope, Stream } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { physical } from "../../missions/physical-path"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { AUTOMATION_BRIDGE_PATH, createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { recurrenceConfigDigest, recurrenceScheduleID } from "./native-recurrence-create"
import { desktopPlugin } from "./managed-owner-plugin"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { nativeRecurrenceDue } from "./native-recurrence-due"

export const DAY = 86_400_000
export const START = Date.parse("2026-10-08T00:00:00Z")
export const DUE = START + (8 * 60 + 15) * 60_000
type Handler = (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>
type NativeTool = { name: string; options?: { namespace?: string }; execute: Handler }
type Job = { id: string; type: string; status: string; metadata?: Record<string, unknown>; run: Effect.Effect<string, unknown>; fiber?: Fiber.Fiber<string, unknown> }
type SessionInfo = typeof Session.Info.Type
type MessageInfo = typeof SessionMessage.Info.Type
export type Schedule = {
  id: string; title: string; revision: number; clock: { time: string; zone: string }; nextDueAt: number
  state: "paused" | "running" | "interrupted" | "stopped"; interruptionReason?: string | null
  pending: null | { status: string; reason?: string; trigger?: string }
  latestResult: null | { passageID: string; outcome: string; reason?: string; trigger?: string }
  history: Array<{ passageID: string; outcome: string; reason?: string; trigger?: string }>; actions: string[]
  lastError?: { code: string; at: number }
}

/** Offline native boundaries only. No recurrence runner, settlement policy or journal event producer lives here.
 * Entry point under test: managed-owner-plugin.desktopPlugin(...).effect(ctx), registering
 * recurrenceCreate / recurrenceControl / recurrenceSnapshot on codenomad.missions.
 * Spec-only wire shapes are deliberately confined to create(), control(), snapshot(). */
export class RecurringDayFixture {
  now = START
  autoDeliver = true
  wakeups = 0
  private wakeTimes: number[] = []
  /** `before-message`: a transient native admission refusal; nothing is admitted. */
  crash: "after-pending" | "after-create" | "before-message" | "after-message" | undefined
  /** Consecutive hits of `crash` before it clears. */
  crashRepeat = 1
  crashHits = 0
  /** Fresh native first admissions (a re-admitted ID after pruning counts again). */
  admissions = 0
  readonly tools = new Map<string, NativeTool>()
  readonly calls: Array<{ name: string; sessionID: string }> = []
  readonly jobs = new Map<string, Job>()
  readonly forms = new Map<string, typeof Form.Info.Type>()
  readonly permissions: unknown[] = []
  readonly shells: unknown[] = []
  readonly background: unknown[] = []
  readonly errors: unknown[] = []
  private handlers = new Map<string, Record<string, Handler>>()
  private hooks: Array<(event: unknown) => Effect.Effect<unknown, unknown>> = []
  private sleepers = new Set<{ at: number; wake: () => void }>()
  private busListeners = new Set<(event: unknown) => Effect.Effect<void>>()
  private scope!: Scope.Closeable
  private graph!: Context.Context<never>
  private ctx!: Plugin.Context
  private db!: DatabaseSync
  private root!: string
  private originalNow = Date.now
  private originalLocal = process.env.LOCALAPPDATA
  private bridge = Fastify({ logger: false })
  private registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  private removeBridge?: () => Promise<void>
  private serial = 0
  private id = ""
  private config!: Record<string, unknown>
  private profileSource!: { profileID: string; executionHost: string; configYamlPath: string }
  private profileScope!: { channel: string; configIdentity: string; key: string }

  static async open() {
    const fixture = new RecurringDayFixture()
    try { await fixture.initialize(); return fixture }
    catch (error) { await fixture.close(); throw error }
  }

  private key(key: string) {
    return `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  }
  private get(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(this.key(key)) as { value: string } | undefined
    return row && JSON.parse(row.value)
  }
  private put(key: string, value: unknown) {
    this.db.prepare("INSERT INTO kv VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated")
      .run(this.key(key), JSON.stringify(value), this.now, this.now)
  }
  private async initialize() {
    const parent = path.join(tmpdir(), "opencode")
    await mkdir(parent, { recursive: true })
    this.root = await mkdtemp(path.join(parent, "recurring-day-"))
    process.env.LOCALAPPDATA = this.root // Never discover the person's real bridge registration.
    Date.now = () => this.now
    execFileSync("git", ["init", "-q", this.root])
    this.root = realpathSync(this.root)
    this.db = new DatabaseSync(path.join(this.root, "service.sqlite"))
    this.db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT,time_suspended INTEGER);
      CREATE TABLE fixture_session(id TEXT PRIMARY KEY,info TEXT,active INTEGER);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER,owner_id TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT,seq INTEGER);
      CREATE TABLE session_inbox(session_id TEXT,id TEXT,payload TEXT);
      CREATE TABLE session_pending(session_id TEXT);`)
    const configYamlPath = path.join(this.root, "profile.yaml")
    await writeFile(configYamlPath, "server:\n  environmentVariables: {}\n")
    this.profileScope = { channel: "day-test", configIdentity: configYamlPath,
      key: createHash("sha256").update(`day-test\0${configYamlPath}`).digest("hex") }
    this.profileSource = { profileID: this.profileScope.key, executionHost: "local", configYamlPath }
    const selected = { agent: "worker", model: { providerID: "fake", id: "offline" } }
    this.config = { title: "Daily offline review", template: "custom", consigne: "Read, run a shell and report the result",
      clock: { time: "08:15", zone: "UTC" }, profileID: this.profileScope.key, executionHost: "local",
      roots: [{ mode: "git", directory: this.root, checkout: physical(this.root), family: await readFamilyAuthorityIdentity(this.root) }],
      profiles: { coordinator: selected, roles: { specialist: selected } }, taskMode: "native", watchedConversationIDs: [] }
    this.bridge.post(AUTOMATION_BRIDGE_PATH, async (request, reply) => {
      if (request.headers["x-codenomad-automation-token"] !== this.registration.token) return reply.code(401).send({})
      const body = request.body as { mode: string; command: { sessionID: string } }
      assert.equal(body.mode, "recurrence-control-verify")
      return { result: { admitted: body.command.sessionID === "offline-human-cookie" } }
    })
    // Authenticated backend boundary stand-in; signing/verification still use the real private bridge.
    this.bridge.post("/day-test/control", async (request, reply) => {
      if (request.headers.cookie !== "session=offline-human-cookie") return reply.code(401).send({})
      const identity = { ...(request.body as object), sessionID: "offline-human-cookie", workspaceID: "owned",
        location: { directory: this.root }, profileSource: this.profileSource, issuedAt: this.now }
      const body = { ...identity, digest: createHash("sha256").update(canonicalAuthority(identity)).digest("hex") }
      const proof = createHmac("sha256", this.registration.token).update(canonicalAuthority(body)).digest("hex")
       return await this.rpc((request.body as { action: string }).action === "run-now" ? "recurrenceRunNow" : "recurrenceControl", { ...body, proof })
    })
    await this.bridge.listen({ host: "127.0.0.1", port: 0 })
    this.registration.url = `http://127.0.0.1:${(this.bridge.server.address() as { port: number }).port}${AUTOMATION_BRIDGE_PATH}`
    this.removeBridge = await publishAutomationBridge(this.registration)
    await this.boot()
  }

  private async boot() {
    this.scope = await Effect.runPromise(Scope.make())
    const tag = (name: string) => Context.Service<never, unknown>(name)
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: this.root,
      project: { id: "day-test", directory: this.root, canonical: this.root } })
    const fixture = this
    const tx = tag("@day-test/Transaction")
    let committedPending = false
    const sql = Object.assign(() => {}, { transactionService: tx,
      unsafe: (query: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => {
        const statement = this.db.prepare(query)
        if (/^(INSERT|UPDATE|DELETE)/.test(query)) {
          statement.run(...params as [])
          if (this.crash === "after-pending" && query.startsWith("UPDATE kv SET value=?")
            && typeof params[0] === "string" && JSON.parse(params[0]).pending) committedPending = true
          return []
        }
        return statement.all(...params as [])
      }) }) })
    const database = { db: { $client: sql, transaction: <A>(callback: () => Effect.Effect<A, unknown>) => Effect.promise(async () => {
      this.db.exec("BEGIN IMMEDIATE")
      let result: A
      try { result = await Effect.runPromiseWith(this.graph)(callback().pipe(Effect.provideService(tx, {}))); this.db.exec("COMMIT") }
      catch (error) { this.db.exec("ROLLBACK"); throw error }
      if (committedPending) { committedPending = false; this.fail("after-pending") }
      return result
    }) } }
    const storage = { get: (key: string) => Effect.sync(() => this.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => this.put(key, value)),
      remove: (key: string) => Effect.sync(() => { this.db.prepare("DELETE FROM kv WHERE key=?").run(this.key(key)) }),
      scan: ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => Effect.sync(() => {
        const rows = this.db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
          .all(this.key(prefix).length, this.key(prefix), this.key(after ?? prefix), limit + 1) as Array<{ key: string; value: string }>
        const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(this.key("").length), value: JSON.parse(row.value) }))
        return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
      }) }
    const native = {
      get: (id: string) => Effect.sync(() => this.session(id)),
      create: (input: Record<string, unknown>) => Effect.sync(() => this.createSession(input)),
      prompt: (input: Record<string, unknown>) => Effect.sync(() => this.admit(input, "user")),
      synthetic: (input: Record<string, unknown>) => Effect.sync(() => this.admit(input, "synthetic")),
      message: (input: { messageID: string }) => Effect.sync(() => this.message(input.messageID)),
      messages: (input: { sessionID: string }) => Effect.sync(() => this.messages(input.sessionID)),
      inbox: (id: string) => Effect.sync(() => this.db.prepare("SELECT payload FROM session_inbox WHERE session_id=?").all(id)
        .map(row => Schema.decodeUnknownSync(SessionInbox.Info)(JSON.parse(String(row.payload))))),
      // Native Session.active is SessionExecution.active: an Effect of the running ID set.
      active: Effect.sync(() => new Set(this.db.prepare("SELECT id FROM fixture_session WHERE active=1").all().map(row => String(row.id)))),
      list: () => Effect.sync(() => ({ data: this.sessions })),
      interrupt: (id: string) => Effect.sync(() => { this.idle(id); return true }),
      cancelInbox: (input: { sessionID: string }) => Effect.sync(() => { this.db.prepare("DELETE FROM session_inbox WHERE session_id=?").run(input.sessionID) }),
      environment: (input: { variables?: unknown }) => Effect.succeed(input.variables ?? {}),
    }
    const job = { get: (id: string) => Effect.sync(() => this.jobs.get(id)),
      start: (input: Job) => Effect.sync(() => {
        const old = this.jobs.get(input.id)
        if (old?.status === "running") return old
        const record = { ...input, status: "running" }
        this.jobs.set(input.id, record)
        record.fiber = Effect.runForkWith(this.graph)(input.run.pipe(Effect.provideService(Clock.Clock, this.clock)))
        void Effect.runPromise(Fiber.await(record.fiber)).then(exit => {
          record.status = Exit.isSuccess(exit) ? "completed" : "error"
          if (Exit.isFailure(exit)) this.errors.push(exit.cause)
        })
        return record
      }), cancel: (id: string) => Effect.promise(async () => {
        const record = this.jobs.get(id)
        if (record?.fiber) await Effect.runPromise(Fiber.interrupt(record.fiber))
        this.jobs.delete(id)
        return record
      }), pendingBackground: Effect.sync(() => this.background) }
    // Native 2.0.26 shape: a borrowed Location graph holds Location services only; Database,
    // Session, Job and Bus are process-global and appear only in plugin/RPC contexts.
    const locationGraph = Context.make(tag("@opencode/Location"), location).pipe(
      Context.add(tag("@opencode/Form"), { list: () => Effect.sync(() => [...this.forms.values()]),
        state: (id: string) => Effect.sync(() => ({ status: this.forms.has(id) ? "pending" : "answered" })),
        reply: (input: { id: string; answer: unknown }) => Effect.sync(() => {
          Schema.decodeUnknownSync(Form.Answer)(input.answer)
          assert(this.forms.delete(input.id), "native Form must still be pending")
        }) }),
      Context.add(tag("@opencode/Permission"), { list: () => Effect.sync(() => this.permissions) }),
      Context.add(tag("@opencode/Shell"), { list: () => Effect.sync(() => this.shells) }))
    this.graph = Context.merge(locationGraph, Context.make(tag("@opencode/storage/Database"), database).pipe(
      Context.add(tag("@opencode/Session"), native), Context.add(tag("@opencode/Job"), job),
      Context.add(tag("@opencode/Bus"), { publish: () => Effect.void, listen: (listener: (event: unknown) => Effect.Effect<void>) =>
        Effect.sync(() => { this.busListeners.add(listener); return Effect.sync(() => { this.busListeners.delete(listener) }) }) }), Context.add(Clock.Clock, this.clock)))
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.sync(() => locationGraph) })
      .pipe(Effect.provideService(Scope.Scope, this.scope)))
    this.graph = Context.add(this.graph, tag("@opencode/example/LocationServiceMap"), { rcMap: map,
      contextEffect: (ref: Location.Ref) => RcMap.get(map, ref), contextEffectOption: (ref: Location.Ref) => RcMap.getOption(map, ref) })
    await Effect.runPromise(Effect.scoped(RcMap.get(map, Schema.decodeUnknownSync(Location.Ref)({ directory: this.root }))))
    const registration = () => ({ dispose: Effect.void })
    const rpc = Object.assign(() => { throw new Error("Unexpected cross-plugin RPC") }, {
      register: (definition: { id: string }, handlers: Record<string, Handler>) => Effect.sync(() => {
        this.handlers.set(definition.id, handlers)
        return { dispose: Effect.sync(() => { this.handlers.delete(definition.id) }), events: { emit: () => Effect.void } }
      }) })
    // Unused plugin domains are fail-fast, not permissive native API emulations.
    const unsupported = (name: string): unknown => new Proxy(() => Effect.die(new Error(`Unimplemented native fixture API: ${name}`)), {
      get: (_target, key) => key === "then" ? undefined : unsupported(`${name}.${String(key)}`),
    })
    const unusedDomains = Object.fromEntries(["agent", "aisdk", "command", "experimental", "generate", "model", "provider",
      "integration", "mcp", "plugin", "permission", "reference", "skill", "vcs", "websearch", "worktree", "shell"]
      .map(name => [name, unsupported(name)]))
    const host = new Proxy({ ...unusedDomains, location, storage, rpc, session: { ...native,
      get: (input: { sessionID: string }) => native.get(input.sessionID),
      interrupt: (input: { sessionID: string }) => Effect.sync(() => { this.idle(input.sessionID); return { interrupted: true } }),
      hook: (_name: string, callback: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { this.hooks.push(callback); return registration() }),
    }, tool: { transform: (callback: (draft: unknown) => void) => Effect.sync(() => {
      callback({ namespace: () => {}, list: () => [...this.tools.values()], get: (name: string) => this.tools.get(name),
        add: (tool: NativeTool) => this.tools.set(`${tool.options?.namespace ?? "mission"}_${tool.name}`, tool) })
      return registration()
    }) }, event: { subscribe: () => Stream.empty }, options: {}, app: {} }, {
      get: (target, key) => key in target ? Reflect.get(target, key) : unsupported(String(key)),
    })
    this.ctx = host as unknown as Plugin.Context
    await Effect.runPromiseWith(Context.add(this.graph, Scope.Scope, this.scope))(
      desktopPlugin(path.join(fixture.root, "absent-backend-presence")).effect(this.ctx))
  }

  private clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => this.now, currentTimeMillis: Effect.sync(() => this.now),
    currentTimeNanosUnsafe: () => BigInt(this.now) * 1_000_000n, currentTimeNanos: Effect.sync(() => BigInt(this.now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(this.now) * 1_000_000n, monotonicTimeNanos: Effect.sync(() => BigInt(this.now) * 1_000_000n),
    sleep: duration => Effect.callback<void>(resume => {
      const sleeper = { at: this.now + Duration.toMillis(duration), wake: () => {
        // The journey spans 32+ hours; measure the requested per-virtual-day
        // ceiling, not its total duration. Keep the maximum monotonic for Pause.
        this.wakeTimes = this.wakeTimes.filter(at => at > this.now - DAY)
        this.wakeTimes.push(this.now)
        this.wakeups = Math.max(this.wakeups, this.wakeTimes.length)
        resume(Effect.void)
      } }
      this.sleepers.add(sleeper)
      return Effect.sync(() => { this.sleepers.delete(sleeper) })
    }),
  }
  async flush() { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setTimeout(resolve, 1)) }
  // Bounded real-time wait for asynchronous storage/admission I/O; virtual time never moves here.
  async until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (!await predicate()) {
      assert(Date.now() < deadline, message)
      await this.flush()
    }
  }
  async advance(to: number) {
    assert(to >= this.now)
    await this.flush()
    while (true) {
      const next = Math.min(...[...this.sleepers].map(s => s.at))
      if (next > to) break
      this.now = next
      for (const sleeper of [...this.sleepers]) if (sleeper.at <= next) { this.sleepers.delete(sleeper); sleeper.wake() }
      await this.flush()
      assert(this.wakeups < 3000, "virtual day runner is spinning")
    }
    this.now = to
    await this.flush()
  }
  private fail(point: NonNullable<RecurringDayFixture["crash"]>) {
    if (this.crash !== point) return
    if (--this.crashRepeat <= 0) { this.crash = undefined; this.crashRepeat = 1 }
    this.crashHits++
    throw new Error(`Injected crash ${point}`)
  }
  private event(sessionID: string, type: string, data: object = {}) {
    const old = this.db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id=?").get(sessionID)
    const seq = Number(old?.seq ?? -1) + 1
    this.db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(`evt_${sessionID}_${seq}`, sessionID, seq, type, JSON.stringify({ sessionID, ...data }))
    this.db.prepare("INSERT INTO event_sequence VALUES(?,?,NULL) ON CONFLICT(aggregate_id) DO UPDATE SET seq=excluded.seq").run(sessionID, seq)
  }
  get sessions(): SessionInfo[] { return this.db.prepare("SELECT info FROM fixture_session").all().map(row => Schema.decodeUnknownSync(Session.Info)(JSON.parse(String(row.info)))) }
  get coordinators() { return this.sessions.filter(s => !s.parentID && !(this.config.watchedConversationIDs as string[]).includes(s.id)) }
  get starts(): MessageInfo[] { return this.db.prepare("SELECT data FROM session_message WHERE type IN ('user','synthetic')").all().map(row => Schema.decodeUnknownSync(SessionMessage.Info)(JSON.parse(String(row.data)))) }
  private session(id: string): SessionInfo {
    const row = this.db.prepare("SELECT info FROM fixture_session WHERE id=?").get(id)
    if (!row) throw new Error(`Native session missing: ${id}`)
    return Schema.decodeUnknownSync(Session.Info)(JSON.parse(String(row.info)))
  }
  private message(id: string): MessageInfo | undefined {
    const row = this.db.prepare("SELECT data FROM session_message WHERE id=?").get(id)
    return row && Schema.decodeUnknownSync(SessionMessage.Info)(JSON.parse(String(row.data)))
  }
  private messages(id: string): MessageInfo[] {
    return this.db.prepare("SELECT data FROM session_message WHERE session_id=? ORDER BY seq").all(id).map(row => Schema.decodeUnknownSync(SessionMessage.Info)(JSON.parse(String(row.data))))
  }
  /** An ordinary user conversation to watch; created before any passage exists. */
  watch(id: string) {
    const info = Schema.decodeUnknownSync(Session.Info)({ id, title: "Watched", location: { directory: this.root }, projectID: "day-test",
      agent: "worker", model: { providerID: "fake", id: "offline" },
      time: { created: this.now, updated: this.now }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    this.db.prepare("INSERT INTO fixture_session VALUES(?,?,0)").run(id, JSON.stringify(Schema.encodeSync(Session.Info)(info)))
    this.db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?,NULL,?,NULL)").run(id, null, "day-test", this.root, "{}")
    this.config.watchedConversationIDs = [id]
  }
  /** Native history pruning: a delivered message disappears; native admission would accept its ID again. */
  pruneMessage(id: string) { this.db.prepare("DELETE FROM session_message WHERE id=?").run(id) }
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM fixture_session WHERE id=?").run(id)
    this.db.prepare("DELETE FROM session_v2 WHERE id=?").run(id)
  }
  private createSession(input: Record<string, unknown>) {
    assert.equal(typeof input.id, "string", "passage caller reserves the native session ID before create")
    if (!input.parentID) this.assertWriteAhead(String(input.id))
    const old = this.sessions.find(s => s.id === input.id)
    if (old) return old
    const info = Schema.decodeUnknownSync(Session.Info)({ ...input, location: { directory: this.root }, projectID: "day-test",
      time: { created: this.now, updated: this.now }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    this.db.prepare("INSERT INTO fixture_session VALUES(?,?,0)").run(info.id, JSON.stringify(Schema.encodeSync(Session.Info)(info)))
    this.db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?,NULL,?,NULL)").run(info.id, info.parentID ?? null, "day-test", this.root, JSON.stringify(info.metadata ?? {}))
    this.event(info.id, "session.created.1")
    this.fail("after-create")
    return info
  }
  private admit(input: Record<string, unknown>, type: "user" | "synthetic") {
    const sessionID = String(input.sessionID), id = String(input.id)
    assert.equal(typeof input.id, "string", "caller message ID required")
    this.assertWriteAhead(id)
    this.session(sessionID)
    this.fail("before-message")
    const payload = { text: input.text, ...(type === "synthetic" ? { description: input.description ?? "Daily passage", metadata: input.metadata ?? {} } : {}) }
    const old = this.db.prepare("SELECT payload FROM session_inbox WHERE id=?").get(id)
    if (old) return Schema.decodeUnknownSync(SessionInbox.Info)(JSON.parse(String(old.payload)))
    if (this.message(id)) return Schema.decodeUnknownSync(SessionInbox.Info)({ id, sessionID, type, payload, delivery: "queue", time: { created: this.now } })
    const item = Schema.decodeUnknownSync(SessionInbox.Info)({ id, sessionID, type, payload, delivery: "queue", time: { created: this.now } })
    this.db.prepare("INSERT INTO session_inbox VALUES(?,?,?)").run(sessionID, id, JSON.stringify(Schema.encodeSync(SessionInbox.Info)(item)))
    this.admissions++
    this.event(sessionID, "session.inbox.enqueued.1", { inboxID: id, item: { type, payload } })
    if (this.autoDeliver) this.deliver(sessionID)
    this.fail("after-message")
    return item
  }
  deliver(sessionID: string) {
    const rows = this.db.prepare("SELECT id,payload FROM session_inbox WHERE session_id=?").all(sessionID)
    for (const row of rows) {
      const item = JSON.parse(String(row.payload))
      const info = Schema.decodeUnknownSync(SessionMessage.Info)({ id: row.id, type: item.type, ...item.payload, time: { created: this.now } })
      this.db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(String(row.id), sessionID, item.type, JSON.stringify(Schema.encodeSync(SessionMessage.Info)(info)), this.messages(sessionID).length)
      this.event(sessionID, "session.inbox.delivered.1", { inboxID: row.id })
    }
    this.db.prepare("DELETE FROM session_inbox WHERE session_id=?").run(sessionID)
    this.db.prepare("UPDATE fixture_session SET active=1 WHERE id=?").run(sessionID)
    this.event(sessionID, "session.execution.started.1")
  }
  private assertWriteAhead(nativeID: string) {
    const docs = this.db.prepare("SELECT value FROM kv WHERE json_extract(value,'$.id')=?").all(this.id)
      .map(row => JSON.parse(String(row.value)))
    assert(docs.some(doc => doc.pending && JSON.stringify(doc.pending).includes(nativeID)),
      `native effect ${nativeID} must follow durable pending identity CAS`)
  }
  idle(id: string, failed = false) {
    this.db.prepare("UPDATE fixture_session SET active=0 WHERE id=?").run(id)
    // Native 2.0.26 shape: no persisted terminal event, only the durable idle projection.
    const info = Schema.decodeUnknownSync(SessionMessage.Info)({ id: `msg_idle_${++this.serial}`, type: "idle",
      outcome: failed ? "failed" : "succeeded", time: { created: this.now } })
    this.db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(info.id, id, "idle",
      JSON.stringify(Schema.encodeSync(SessionMessage.Info)(info)), this.messages(id).length)
    // Native Bus listeners run inline during publish (session.execution terminal payloads).
    for (const listener of this.busListeners) Effect.runSync(listener({ type: failed ? "session.execution.failed" : "session.execution.succeeded" }))
  }
  async model(options: { child?: boolean; report?: boolean; keepActive?: boolean; failed?: boolean } = {}) {
    const coordinator = this.coordinators.at(-1)!
    assert(coordinator, "coordinator prompt must arrive before scripted model work")
    const available: Record<string, unknown> = { read: {}, shell: {}, ...Object.fromEntries(this.tools) }
    const event = { sessionID: coordinator.id, system: [], tools: available }
    for (const hook of this.hooks) await Effect.runPromiseWith(this.graph)(hook(event))
    for (const name of ["read", "shell"]) { assert(name in available, `${name} cannot be whitelisted away`); this.calls.push({ name, sessionID: coordinator.id }) }
    if (options.child) {
      const child = this.createSession({ id: `ses_child_${++this.serial}`, parentID: coordinator.id })
      this.calls.push({ name: "subagent", sessionID: child.id }); this.idle(child.id)
    }
    if (options.report !== false) {
      await this.tool("mission_inspect", {}, coordinator.id)
      await this.tool("mission_report", { outcome: "completed", summary: "Read and shell work completed", final: true }, coordinator.id)
    }
    if (!options.keepActive) this.idle(coordinator.id, options.failed)
    await this.flush()
  }
  private async tool(name: string, input: unknown, sessionID: string) {
    const tool = this.tools.get(name)
    assert(tool, `backend-independent real ${name} registration missing`)
    this.calls.push({ name, sessionID })
    return Effect.runPromiseWith(this.graph)(tool.execute(input, { sessionID, messageID: `msg_model_${this.serial}`,
      id: `call_${++this.serial}`, progress: () => Effect.void, signal: new AbortController().signal }))
  }
  pendingForm() {
    const form = Schema.decodeUnknownSync(Form.Info)({ id: "frm_day", sessionID: this.coordinators.at(-1)!.id,
      title: "Confirm review", fields: [{ key: "ok", type: "boolean", required: true }] })
    this.forms.set(form.id, form)
    return form.id
  }
  async answerForm(id: string) {
    const form = Context.get(this.graph, Context.Service<never, {
      reply(input: { id: string; answer: unknown }): Effect.Effect<void>
    }>("@opencode/Form"))
    await Effect.runPromise(form.reply({ id, answer: { ok: true } }))
    await this.flush()
  }
  async rpc(method: string, input: unknown = {}) {
    const handler = this.handlers.get(CODENOMAD_MISSIONS_RPC_ID)?.[method]
    assert(handler, `real plugin RPC ${method} missing without CodeNomad presence`)
    return Effect.runPromiseWith(Context.add(this.graph, Scope.Scope, this.scope))(handler(input, {
      error: (_type: string, message: string) => new Error(message), signal: new AbortController().signal,
    }))
  }
  async create() {
    const requestID = "create_day_test"
    this.id = recurrenceScheduleID("day-test", this.root, requestID)
    const digest = recurrenceConfigDigest(this.config)
    const identity = { sessionID: "offline-human-cookie", workspaceID: "owned", location: { directory: this.root },
      scheduleID: this.id, requestID, expectedRevision: 0, action: "create", configDigest: digest,
      profileSource: this.profileSource, issuedAt: this.now }
    const body = { ...identity, digest: createHash("sha256").update(canonicalAuthority(identity)).digest("hex") }
    const transport = { ...body, proof: createHmac("sha256", this.registration.token).update(canonicalAuthority(body)).digest("hex") }
    await this.rpc("recurrenceCreate", { id: this.id, requestID, config: this.config,
      digest, directory: this.root, scope: this.profileScope, executionHost: "local", transport })
    return this.snapshot()
  }
  async snapshot(): Promise<Schedule> {
    const response = await this.rpc("recurrenceSnapshot") as { schedules: Schedule[] }
    const schedule = response.schedules.find(s => s.id === this.id)
    assert(schedule, "created schedule must be present in real snapshot")
    return schedule
  }
  async control(action: "play" | "pause" | "stop" | "resume" | "run-now" | "check") {
    const schedule = await this.snapshot()
    const response = await this.bridge.inject({ method: "POST", url: "/day-test/control", headers: { cookie: "session=offline-human-cookie" },
      payload: { scheduleID: this.id, action, requestID: `human_${++this.serial}`, expectedRevision: schedule.revision } })
    assert.equal(response.statusCode, 200, `${action}: ${response.body}`)
    await this.flush()
    return this.snapshot()
  }
  async document() {
    const store = await Effect.runPromiseWith(this.graph)(acquireNativeRecurrenceStore(this.ctx))
    return store.read(this.id) // Real recurrence store, read only; no fixture-side lifecycle/reserve/finish shortcut.
  }
  /** Crash stand-in: the durable bytes a lost write would have left behind. */
  rewriteDocument(change: (doc: Record<string, any>) => void) {
    const key = this.db.prepare("SELECT key FROM kv WHERE json_extract(value,'$.id')=?").get(this.id) as { key: string }
    const doc = JSON.parse(String((this.db.prepare("SELECT value FROM kv WHERE key=?").get(key.key) as { value: string }).value))
    change(doc)
    this.db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(doc), key.key)
  }
  /** One due wake exactly as a Job of that role invokes it, in the native graph. */
  async wake(settleOnly: boolean) {
    const doc = await this.document()
    const due = nativeRecurrenceDue(this.ctx, { projectID: "day-test", projectCanonical: this.root, directory: this.root,
      scheduleID: this.id, profileID: this.profileScope.key, executionHost: "local", profileSource: doc!.profileSource, settleOnly })
    return Effect.runPromiseWith(Context.add(this.graph, Scope.Scope, this.scope))(
      Effect.scoped(due(this.id, () => true, new AbortController().signal)))
  }
  async restart() {
    for (const job of this.jobs.values()) if (job.fiber) await Effect.runPromise(Fiber.interrupt(job.fiber))
    this.jobs.clear(); this.sleepers.clear()
    await Effect.runPromise(Scope.close(this.scope, Exit.void))
    this.handlers.clear(); this.tools.clear(); this.hooks = []
    this.forms.clear(); this.permissions.length = 0; this.shells.length = 0; this.background.length = 0
    await this.boot() // SQLite sessions/messages/calendar retained; never rearm from the fixture.
  }
  async close() {
    try {
      for (const job of this.jobs.values()) if (job.fiber) await Effect.runPromise(Fiber.interrupt(job.fiber))
      if (this.scope) await Effect.runPromise(Scope.close(this.scope, Exit.void))
      await this.removeBridge?.()
      await this.bridge.close()
      this.db?.close()
      if (this.root) await rm(this.root, { recursive: true, force: true })
    } finally {
      Date.now = this.originalNow
      if (this.originalLocal === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = this.originalLocal
    }
  }
}
