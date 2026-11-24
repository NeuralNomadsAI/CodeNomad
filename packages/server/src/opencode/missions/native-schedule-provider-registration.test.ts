import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/effect/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { assertNativeScheduleProviderAvailable, registerNativeScheduleProvider } from "./native-schedule-provider-registration"

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "schedule-provider-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const artifact = (name: string) => {
    const bytes = Buffer.from(name), file = path.join(root, name)
    writeFileSync(file, bytes)
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const artifacts = { provider: artifact("local %20 provider.mjs"), runtime: artifact("runtime.mjs") }
  const transforms: Array<(editor: ProviderEditor) => void> = [], external = new Map<string, ProviderRecord>()
  const ordinaryID = Provider.ID.make("ordinary"), ordinaryModel = Model.Info.default(ordinaryID, Model.ID.make("normal"))
  external.set(ordinaryID, { provider: { ...Provider.Info.empty(ordinaryID), package: "ordinary-package" }, models: new Map([[ordinaryModel.id, ordinaryModel]]) })
  let records = new Map(external), drift: ((model: Model.Info) => Model.Info) | undefined
  const replay = () => {
    records = new Map(external)
    const editor = { get: (id: string) => records.get(id), add: ({ info, models }: Parameters<ProviderEditor["add"]>[0]) =>
      records.set(info.id, { provider: info, models: new Map(models.map(model => [model.id, model])) }) } as unknown as ProviderEditor
    for (const transform of transforms) transform(editor)
  }
  const ctx = { provider: {
    transform: (callback: (editor: ProviderEditor) => void) => Effect.sync(() => { transforms.push(callback); return { dispose: Effect.void } }),
    get: ({ providerID }: { providerID: string }) => Effect.sync(() => { replay(); return { data: { ...records.get(providerID)?.provider, canonical: undefined } } }),
  }, model: { list: () => Effect.sync(() => ({ data: [...records.values()].flatMap(record => [...record.models.values()])
    .map(model => ({ ...(model.providerID === NATIVE_SCHEDULE_CARRIER_MODEL.providerID && drift ? drift(model) : model), compatibility: undefined, family: undefined })) })) } } as unknown as Plugin.Context
  return { artifacts, ctx, external, replay, records: () => records, drift: (change: typeof drift) => { drift = change } }
}

test("public provider transform adds only the exact local model and never changes ordinary defaults", async t => {
  const f = fixture(t)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerNativeScheduleProvider(f.ctx, f.artifacts)
    yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts)
    const record = f.records().get(NATIVE_SCHEDULE_CARRIER_MODEL.providerID)!
    assert.equal(record.provider.package, `aisdk:${pathToFileURL(f.artifacts.provider.file).href}`)
    assert.equal(record.provider.activation, "enabled")
    assert.equal(record.provider.integrationID, undefined)
    const model = record.models.get(NATIVE_SCHEDULE_CARRIER_MODEL.id)!
    assert.deepEqual(model.capabilities, { tools: false, input: ["text"], output: ["text"], temperature: false })
    assert.deepEqual(model.limit, { context: 32000, input: 27904, output: 4096 })
    assert.deepEqual(model.cost, [])
    assert.deepEqual(model.variants, [])
    assert.equal(f.records().get("ordinary"), f.external.get("ordinary"))
    f.replay()
    yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts)
    // An external contribution remains a collision even with byte-identical
    // public metadata; only this scope's successful add admits the carrier.
    f.external.set(NATIVE_SCHEDULE_CARRIER_MODEL.providerID, record)
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit))._tag, "Failure")
    assert.equal(f.records().get(NATIVE_SCHEDULE_CARRIER_MODEL.providerID), record)
  })))
  await assert.rejects(Effect.runPromise(assertNativeScheduleProviderAvailable(f.ctx, f.artifacts)), /schedule-provider-unavailable/)
})

test("reserved external provider collision stays intact and blocks only scheduling", async t => {
  const f = fixture(t), id = Provider.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.providerID)
  const collision = { provider: { ...Provider.Info.empty(id), package: "foreign-package" }, models: new Map() }
  f.external.set(id, collision)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerNativeScheduleProvider(f.ctx, f.artifacts)
    const refused = yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit)
    assert.equal(refused._tag, "Failure")
    assert.equal(f.records().get(id), collision)
    assert.equal(f.records().get("ordinary"), f.external.get("ordinary"))
  })))
})

test("artifact damage, model transform drift and mismatched manifests refuse technical admission", async t => {
  const f = fixture(t)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerNativeScheduleProvider(f.ctx, f.artifacts)
    yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts)
    f.drift(model => ({ ...model, capabilities: { ...model.capabilities, tools: true } }))
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit))._tag, "Failure")
    f.drift(undefined)
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, { ...f.artifacts, provider: { ...f.artifacts.provider, sha256: "0".repeat(64) } }).pipe(Effect.exit))._tag, "Failure")
    writeFileSync(f.artifacts.provider.file, "changed")
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit))._tag, "Failure")
    f.replay()
    assert.equal(f.records().get(NATIVE_SCHEDULE_CARRIER_MODEL.providerID), undefined)
    assert.equal(f.records().get("ordinary"), f.external.get("ordinary"))
  })))
})

test("bad artifacts and a missing public transform never fail ordinary plugin setup", async t => {
  const f = fixture(t)
  rmSync(f.artifacts.runtime.file)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerNativeScheduleProvider(f.ctx, f.artifacts)
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit))._tag, "Failure")
  })))
  await Effect.runPromise(Effect.scoped(registerNativeScheduleProvider({} as never, f.artifacts)))
})

test("a retained calendar runtime remains qualified across a bundle replacement with the same provider", async t => {
  const f = fixture(t), bytes = "current owned runtime", file = path.join(path.dirname(f.artifacts.runtime.file), "new-runtime.mjs")
  writeFileSync(file, bytes)
  const current = { ...f.artifacts, runtime: { file, sha256: createHash("sha256").update(bytes).digest("hex") } }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerNativeScheduleProvider(f.ctx, current)
    yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts)
    rmSync(f.artifacts.runtime.file)
    assert.equal((yield* assertNativeScheduleProviderAvailable(f.ctx, f.artifacts).pipe(Effect.exit))._tag, "Failure")
    yield* assertNativeScheduleProviderAvailable(f.ctx, current)
  })))
})
