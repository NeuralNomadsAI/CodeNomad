import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { BundlesActions, type BundlesAction, type BundlesHostContext } from "./bundles-actions"
import { BundlesLifecycle, type BundlesConfirmation, type BundlesPrepared } from "./bundles-lifecycle"
import { catalogEntry, catalogOf } from "../opencode/integrations/catalog-fixture"
import { IntegrationAttachments } from "../opencode/integrations/attachments"
import { recognizeIntegrations } from "../opencode/integrations/recognition"
import { PluginControls } from "../opencode/plugin-controls"
import { appendPluginControlRule } from "../opencode/plugin-control-document"
import { PluginSources } from "../opencode/plugin-sources"
import { PluginPackages } from "../opencode/plugin-packages"
import { NativeMutationUncertainError } from "../opencode/native-mutation-authority"
import { BundlesTransport } from "./bundles-transport"
import { EventBus } from "../events/bus"
import { setTimeout as delay } from "node:timers/promises"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const runtimeAction = (action: "attach" | "installHost" | "update"): BundlesAction => action === "attach"
  ? { action, integration: "fixture", offerID: "offer_fixture" }
  : action === "installHost" ? { action, integration: "fixture" } : { action, integration: "fixture", scope: "global" }
async function fixture(installed = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bundles-actions-")), global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const file = path.join(global, "opencode.jsonc"), entry = catalogEntry("fixture"), catalogReads: unknown[] = []
  const spec = `${entry.package}@${entry.range}`
  await writeFile(file, JSON.stringify({ plugins: installed ? [spec] : [] }) + "\n")
  const state = { catalog: catalogOf(entry), runtime: installed ? [{ id: entry.plugin,
    source: { type: "package", target: spec, version: "0.1.0" }, features: {}, state: { status: "active" } }] : [] as any[],
    offers: [{ offerID: "offer_fixture", label: "Fixture window", document: "Scene.blend", appVersion: "5.0.0", protocol: "ok" }],
    current: true, owned: true, session: "ses_fixture", directory: project, globalDirectory: global, title: "Conversation", metadata: { unrelated: true } as Record<string, unknown>,
    rpc: [] as string[], updates: [] as unknown[], packageUpdates: [] as unknown[], wsl: undefined as string | undefined,
    status: { contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
      host: { state: "ok" }, connection: { state: "available", offers: 1, attachedSessions: 0 } } as any,
    installOutput: { outcome: "installed" } as unknown, rpcInputs: [] as unknown[],
    onInstallHost: undefined as (() => void | Promise<void>) | undefined,
    documentPaths: [file], configEntries: undefined as any[] | undefined,
    onUpdate: undefined as (() => void | Promise<void>) | undefined, onRpc: undefined as ((method: string) => void | Promise<void>) | undefined,
    onAuthorize: undefined as (() => void | Promise<void>) | undefined }
  const abort = new AbortController()
  const connection: any = { assertCurrent() { if (!state.current) throw new Error("connection changed") }, client: {
    config: { get: async () => state.configEntries ?? [{ type: "directory", path: state.globalDirectory },
      ...await Promise.all(state.documentPaths.map(async file => ({ type: "document", path: file, info: parse(await readFile(file, "utf8")) })))] },
    plugin: { list: async () => ({ data: state.runtime }), update: async (input: unknown) => {
      state.packageUpdates.push(input); state.runtime[0].source.version = "0.2.0"; await state.onUpdate?.()
    } },
    session: { get: async () => ({ id: state.session, location: { directory: state.directory }, title: state.title, metadata: { ...state.metadata } }),
      update: async (input: any) => { state.updates.push(input); state.metadata = input.metadata } },
    rpc: { call: async (request: any) => {
      const { rpcID, method } = request
      assert.equal(rpcID, entry.rpc); state.rpc.push(method); state.rpcInputs.push(request); await state.onRpc?.(method)
      if (method === "installHost") { await state.onInstallHost?.(); return { output: state.installOutput } }
      return { output: method === "status" ? structuredClone(state.status)
        : method === "hosts" ? { offers: state.offers }
        : { outcome: method === "attachHost" ? "attached" : method === "detachHost" ? "detached" : "installed" } }
    } },
  } }
  const manager: any = { get: () => ({}), getSharedServiceConnection: async () => connection,
    ownsLocation: async () => state.owned, getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async () => "owned", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => state.wsl, getHostPathForServicePath: async (_id: string, value: string) => value }
  const catalog = { snapshot: () => ({ state: "fresh" as const, catalog: state.catalog }),
    read: async (options?: { refresh?: boolean }) => { catalogReads.push(options); return catalog.snapshot() } }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } as any })
  const sources = new PluginSources({ documents: controls, catalog, logger: { info() {} } as any })
  const packages = new PluginPackages({ controls, workspaceManager: manager })
  const attachments = new IntegrationAttachments({ controls, catalog, workspaceManager: manager, hostPlatform: "win32" })
  const context: BundlesHostContext = { instanceId: "w", sessionID: "ses_fixture", location: { directory: project }, connection,
    authority: { signal: abort.signal, assertCurrent() { abort.signal.throwIfAborted(); connection.assertCurrent() }, async revalidate() {
      await state.onAuthorize?.(); abort.signal.throwIfAborted(); connection.assertCurrent()
      if (!state.owned || state.session !== "ses_fixture" || state.directory !== project) throw new Error("captured identity changed")
    } } }
  const actions = new BundlesActions({ workspaceManager: manager, catalog, controls, sources, packages, attachments })
  const prepare = (action: BundlesAction) => actions.prepare(context, action, abort.signal)
  const dispatch = (plan: BundlesPrepared, notify = () => {}) => plan.dispatch({
    assertCurrent: () => context.authority.assertCurrent(),
    async revalidate() { await context.authority.revalidate(); assert.deepEqual(await plan.readTarget(abort.signal), plan.target) },
  }, notify)
  return { root, global, project, file, spec, state, entry, manager, catalog, catalogReads, controls, sources, packages, attachments,
    abort, context, actions, prepare, dispatch, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function splitGlobalDocuments(f: Awaited<ReturnType<typeof fixture>>) {
  const declaration = path.join(f.global, "opencode.json")
  await writeFile(declaration, await readFile(f.file, "utf8"))
  await writeFile(f.file, '{"plugins":[]}\n')
  f.state.documentPaths = [declaration, f.file]
  return declaration
}

test("synchronous admission uses only the existing catalogue snapshot and rejects native Project or unknown targets", async () => {
  const f = await fixture()
  try {
    for (const action of ["install", "update", "setActive"] as const) {
      const request: BundlesAction = action === "setActive" ? { action, integration: "fixture", scope: "project", active: false }
        : { action, integration: "fixture", scope: "project" }
      assert.equal(f.actions.accepts(request), false)
      assert.equal(f.actions.accepts({ ...request, scope: "global" }), true)
      assert.equal(f.actions.accepts({ ...request, integration: "unknown" }), false)
      f.state.catalog = catalogOf(catalogEntry("fixture", { family: "api" }))
      assert.equal(f.actions.accepts(request), true)
      assert.equal(f.actions.accepts({ action: "installHost", integration: "fixture" }), false)
      f.state.catalog = catalogOf(f.entry)
    }
    f.state.catalog = catalogOf()
    assert.equal(f.actions.accepts({ action: "attach", integration: "fixture", offerID: "offer_fixture" }), false)
    assert.deepEqual(f.catalogReads, []); assert.deepEqual(f.state.rpc, [])
    assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
  } finally { await f.cleanup() }
})

test("real source/activation writers accept their own exact changes, retaining postsubmission authority", async () => {
  for (const action of ["install", "setActive"] as const) {
    const f = await fixture(action !== "install")
    try {
      const plan = await f.prepare(action === "install" ? { action, integration: "fixture", scope: "global" }
        : { action, integration: "fixture", scope: "global", active: false })
      let submitted = 0
      await f.dispatch(plan, () => { submitted++ })
      assert.equal(submitted, 1)
      assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, action === "install" ? [f.spec] : [f.spec, "-neuralnomads.fixture"])
      assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
      assert.ok(f.catalogReads.length > 2); assert.ok(f.catalogReads.every(options => (options as any)?.refresh === false))
      await writeFile(f.file, (await readFile(f.file, "utf8")) + "// foreign edit\n")
      assert.notDeepEqual(await plan.readTarget(f.abort.signal), plan.target, "postsubmission authority still detects external edits")
    } finally { await f.cleanup() }
  }
})

test("catalogue identity, exact raw document bytes/destination and runtime package changes refuse before submission", async () => {
  for (const change of ["id", "family", "package", "plugin", "rpc", "range", "document", "destination", "runtime"] as const) {
    const f = await fixture(change === "runtime")
    try {
      const plan = await f.prepare({ action: change === "runtime" ? "update" : "install", integration: "fixture", scope: "global" })
      if (change === "document") await writeFile(f.file, '{"plugins":[],"external":true}\n')
      else if (change === "destination") f.state.globalDirectory = f.project
      else if (change === "runtime") f.state.runtime[0].source.target += "-changed"
      else (f.state.catalog.integrations[0] as any)[change] = change === "family" ? "api" : "changed"
      const before = await readFile(f.file, "utf8")
      let submitted = 0
      await assert.rejects(f.dispatch(plan, () => { submitted++ }), change)
      assert.equal(submitted, 0, change); assert.equal(await readFile(f.file, "utf8"), before)
      assert.equal(f.state.packageUpdates.length, 0)
    } finally { await f.cleanup() }
  }
})

test("native installs are global-only; WSL host preflight refuses before any catalogue/native read", async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.prepare({ action: "install", integration: "fixture", scope: "project" }))
    f.catalogReads.length = 0; f.state.wsl = "fixture"
    await assert.rejects(f.prepare({ action: "installHost", integration: "fixture" }), (error: any) => error.code === "unsupported")
    assert.deepEqual(f.catalogReads, []); assert.deepEqual(f.state.rpc, [])
    assert.deepEqual(await readdir(f.global), ["opencode.jsonc"])
  } finally { await f.cleanup() }
  const installed = await fixture(true)
  try {
    installed.state.status.host = { state: "absent", action: "install" }
    const plan = await installed.prepare({ action: "installHost", integration: "fixture" })
    installed.catalogReads.length = 0; installed.state.rpc.length = 0; installed.state.wsl = "fixture"
    await assert.rejects(plan.readTarget(installed.abort.signal), (error: any) => error.code === "unsupported")
    assert.deepEqual(installed.catalogReads, []); assert.deepEqual(installed.state.rpc, [])
  } finally { await installed.cleanup() }
})

test("new missing config targets accept their own creation; host installation submits once through the native service", async () => {
  const f = await fixture()
  try {
    await rm(f.file)
    const originalGet = f.context.connection.client.config.get
    f.context.connection.client.config.get = (async (...args: any[]) => {
      try { return await (originalGet as any)(...args) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [{ type: "directory", path: f.global }]; throw error }
    }) as any
    const plan = await f.prepare({ action: "install", integration: "fixture", scope: "global" })
    await f.dispatch(plan)
    assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
    assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, [f.spec])
  } finally { await f.cleanup() }
  const installed = await fixture(true)
  try {
    installed.state.status.host = { state: "absent", action: "install", expectedRange: "^0.1.0" }
    const plan = await installed.prepare({ action: "installHost", integration: "fixture" })
    let submitted = 0
    await installed.dispatch(plan, () => { submitted++ })
    assert.equal(submitted, 1); assert.equal(installed.state.rpc.filter(method => method === "installHost").length, 1)
    assert.deepEqual(installed.state.updates, [])
    assert.ok(installed.catalogReads.every(options => (options as any)?.refresh === false))
  } finally { await installed.cleanup() }
})

test("all native project-scoped builders refuse with no config, package, RPC or metadata effects", async () => {
  for (const action of ["install", "update", "setActive"] as const) {
    for (const active of action === "setActive" ? [false, true] : [false]) {
      const f = await fixture(action !== "install")
      try {
        const before = await readFile(f.file, "utf8")
        await assert.rejects(f.prepare(action === "setActive" ? { action, integration: "fixture", scope: "project", active }
          : { action, integration: "fixture", scope: "project" }))
        assert.equal(await readFile(f.file, "utf8"), before)
        assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
        assert.deepEqual(await readdir(f.global), ["opencode.jsonc"]); assert.deepEqual(await readdir(f.project), [])
      } finally { await f.cleanup() }
    }
  }
})

test("host installation requires explicit validated absent/install or versioned outdated/update; unknown never infers install", async () => {
  const forbidden = [undefined, {}, { state: "unknown" }, { state: "unknown", action: "install" }, { state: "unknown", action: "update", partVersion: "0.0.1" },
    { state: "ok" }, { state: "ok", action: "install" }, { state: "ok", action: "update" },
    { state: "absent" }, { state: "absent", action: "update" }, { state: "absent", action: "install", partVersion: "0.0.1" },
    { state: "outdated" }, { state: "outdated", action: "update" }, { state: "outdated", action: "install", partVersion: "0.0.1" },
    { state: "incompatible", action: "update", partVersion: "0.0.1" }, { state: "unsupported", action: "install" }]
  for (const host of forbidden) {
    const f = await fixture(true)
    try {
      f.state.status.host = host
      await assert.rejects(f.prepare({ action: "installHost", integration: "fixture" }), JSON.stringify(host))
      assert.ok(!f.state.rpc.includes("installHost")); assert.deepEqual(f.state.updates, [])
      assert.equal(await readFile(f.file, "utf8"), JSON.stringify({ plugins: [f.spec] }) + "\n")
      assert.ok(f.catalogReads.every(options => (options as any)?.refresh === false))
    } finally { await f.cleanup() }
  }
})

test("install/update plans capture fresh status version and permit only expected post-submission host transitions", async () => {
  for (const intent of ["install", "update"] as const) {
    for (const after of ["unchanged", "ok", "unknown"] as const) {
      const f = await fixture(true)
      try {
        f.state.status.integration.version = "0.2.0"
        f.state.status.host = intent === "install" ? { state: "absent", action: "install", expectedRange: "^0.2.0" }
          : { state: "outdated", action: "update", partVersion: "0.1.0", expectedRange: "^0.2.0", appVersion: "5.0.0" }
        f.state.installOutput = { outcome: intent === "install" ? "installed" : "updated" }
        const plan = await f.prepare({ action: "installHost", integration: "fixture" })
        assert.equal(plan.display.version, "0.2.0", "confirmation version comes from fresh validated native status")
        f.state.onInstallHost = () => {
          if (after === "ok") f.state.status.host = { state: "ok", partVersion: "0.2.0", expectedRange: "^0.2.0", appVersion: "5.0.0" }
          else if (after === "unknown") f.state.status.host = { state: "unknown", expectedRange: "^0.2.0" }
        }
        let submitted = 0
        await f.dispatch(plan, () => { submitted++ })
        assert.equal(submitted, 1)
        assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
        assert.deepEqual(f.state.rpcInputs.filter((input: any) => input.method === "installHost"), [
          { rpcID: f.entry.rpc, method: "installHost", input: { target: "default" }, location: f.context.location },
        ])
        assert.ok(f.state.rpcInputs.filter((input: any) => input.method === "status").every((input: any) =>
          input.rpcID === f.entry.rpc && Object.keys(input.input).length === 0 && input.location.directory === f.project))
        assert.ok(f.catalogReads.every(options => (options as any)?.refresh === false))
        // Expected host effects never exempt the live catalogue or captured package/runtime version.
        f.state.runtime[0].source.version = "0.3.0"
        assert.notDeepEqual(await plan.readTarget(f.abort.signal), plan.target)
        f.abort.abort(); await assert.rejects(plan.readTarget(f.abort.signal))
      } finally { await f.cleanup() }
    }
  }
})

test("stale host action/state/versions refuse before installation, including changes during native prerequisite waits", async () => {
  for (const change of ["action", "state", "version", "partVersion", "expectedRange", "appVersion", "runtimeVersion", "duringRead"] as const) {
    const f = await fixture(true), entered = deferred(), release = deferred()
    try {
      f.state.status.host = { state: "outdated", action: "update", partVersion: "0.0.1", expectedRange: "^0.1.0", appVersion: "5.0.0" }
      const plan = await f.prepare({ action: "installHost", integration: "fixture" })
      if (change === "duringRead") {
        let held = false
        f.state.onRpc = async method => { if (method === "status" && !held) { held = true; entered.resolve(); await release.promise } }
      } else if (change === "action") f.state.status.host.action = "install"
      else if (change === "state") f.state.status.host.state = "unknown"
      else if (change === "version") f.state.status.integration.version = "0.2.0"
      else if (change === "runtimeVersion") f.state.runtime[0].source.version = "0.2.0"
      else f.state.status.host[change] = change === "appVersion" ? "6.0.0" : change === "partVersion" ? "0.0.2" : "^0.2.0"
      let submitted = 0
      const work = f.dispatch(plan, () => { submitted++ }), rejected = assert.rejects(work)
      if (change === "duringRead") { await entered.promise; f.state.status.host.action = "install"; release.resolve() }
      await rejected
      assert.equal(submitted, 0, change); assert.ok(!f.state.rpc.includes("installHost"), change)
      assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
    } finally { release.resolve(); await f.cleanup() }
  }
})

test("postsubmission host effects cannot normalize foreign host/version, catalogue or consent changes", async () => {
  for (const change of ["hostVersion", "hostRange", "hostAction", "statusVersion", "catalogue", "consent"] as const) {
    const f = await fixture(true)
    try {
      f.state.status.host = { state: "absent", action: "install", expectedRange: "^0.1.0" }
      const plan = await f.prepare({ action: "installHost", integration: "fixture" })
      f.state.onInstallHost = () => {
        f.state.status.host = { state: "ok", partVersion: "0.1.0", expectedRange: "^0.1.0" }
        if (change === "hostVersion") f.state.status.host.partVersion = "0.2.0"
        else if (change === "hostRange") f.state.status.host.expectedRange = "^0.2.0"
        else if (change === "hostAction") f.state.status.host.action = "update"
        else if (change === "statusVersion") f.state.status.integration.version = "0.2.0"
        else if (change === "catalogue") f.state.catalog.integrations[0]!.range = "^0.2.0"
        else f.abort.abort()
      }
      let submitted = 0
      await assert.rejects(f.dispatch(plan, () => { submitted++ }), NativeMutationUncertainError)
      assert.equal(submitted, 1); assert.equal(f.state.rpc.filter(method => method === "installHost").length, 1)
    } finally { await f.cleanup() }
  }
})

test("malformed, unsafe and raw native host outputs remain private and never authorize installation", async () => {
  const secret = "PRIVATE_HOST_TOKEN_SCRIPT_SENTINEL"
  const cases: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    f => { f.state.status = { raw: secret } }, f => { f.state.status = null },
    f => { f.state.status.contract = 2 }, f => { f.state.status.integration.spec = 1 },
    f => { f.state.status.integration.id = "other" }, f => { f.state.status.integration.family = "api" },
    f => { f.state.status.integration.version = `C:${secret}` }, f => { f.state.status.host.partVersion = `/${secret}` },
    f => { f.state.status.host.appVersion = `C:${secret}` }, f => { f.state.status.host.appVersion = `~${secret}` },
    f => { f.state.status.host.expectedRange = `/${secret}` },
    f => { f.state.status.host.state = secret }, f => { f.state.status.connection.offers = -1 },
    f => { f.state.onRpc = method => { if (method === "status") throw new Error(secret) } },
  ]
  for (const corrupt of cases) {
    const f = await fixture(true)
    try {
      f.state.status.host = { state: "absent", action: "install", expectedRange: "^0.1.0" }; corrupt(f)
      await assert.rejects(f.prepare({ action: "installHost", integration: "fixture" }), error => {
        assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret)); return true
      })
      assert.ok(!f.state.rpc.includes("installHost"))
    } finally { await f.cleanup() }
  }
  const f = await fixture(true)
  try {
    f.state.status.host = { state: "absent", action: "install", expectedRange: "^0.1.0", raw: secret }
    f.state.status.raw = { token: secret }
    const plan = await f.prepare({ action: "installHost", integration: "fixture" })
    assert.ok(!JSON.stringify(plan).includes(secret)); assert.ok(!JSON.stringify(plan.display).includes(secret))
    f.state.installOutput = { outcome: "installed", detail: `/${secret}` }
    await assert.rejects(f.dispatch(plan), error => {
      assert.ok(error instanceof NativeMutationUncertainError); assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret)); return true
    })
    assert.equal(f.state.rpc.filter(method => method === "installHost").length, 1)
  } finally { await f.cleanup() }
})

test("real document queue wait revalidates revocation and concurrent document changes", async () => {
  for (const change of ["revoke", "document"] as const) {
    const f = await fixture(true), entered = deferred(), release = deferred()
    try {
      const plan = await f.prepare({ action: "setActive", integration: "fixture", scope: "global", active: false })
      const first = f.controls.editConfigDocument("w", f.context.location, "global", async document => {
        entered.resolve(); await release.promise
        return change === "document" ? document.text + "// concurrent\n" : document.text
      })
      await entered.promise
      let submitted = 0
      const pending = f.dispatch(plan, () => { submitted++ }), rejected = assert.rejects(pending)
      if (change === "revoke") f.abort.abort()
      release.resolve(); await first; await rejected
      assert.equal(submitted, 0)
      assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, [f.spec])
    } finally { release.resolve(); await f.cleanup() }
  }
})

test("native update uses the exact recognized target, permits its own version change, and keeps uncertainty sticky", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(true)
    try {
      const plan = await f.prepare({ action: "update", integration: "fixture", scope: "global" })
      let submitted = 0
      if (revoke) f.state.onUpdate = () => f.abort.abort()
      const result = f.dispatch(plan, () => { submitted++ })
      if (revoke) await assert.rejects(result, NativeMutationUncertainError)
      else { await result; assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target) }
      assert.equal(submitted, 1)
      assert.deepEqual(f.state.packageUpdates, [{ location: f.context.location, targets: [f.spec] }])
      assert.equal(f.state.runtime[0].source.version, "0.2.0")
    } finally { await f.cleanup() }
  }
})

test("attach, host install and update bind exact raw document bytes, physical destination and mode", async () => {
  for (const action of ["attach", "installHost", "update"] as const) {
    for (const change of ["document", "destination", "mode"] as const) {
      const f = await fixture(true), originalMode = (await stat(f.file)).mode & 0o777
      try {
        f.state.status.host = { state: "absent", action: "install" }
        const plan = await f.prepare(runtimeAction(action))
        const before = await readFile(f.file, "utf8")
        if (change === "document") await writeFile(f.file, before + "// external edit\n")
        else if (change === "mode") await chmod(f.file, originalMode ^ 0o200)
        else {
          const mapped = path.join(f.root, "mapped")
          await mkdir(mapped); await writeFile(path.join(mapped, "opencode.jsonc"), before)
          f.manager.getHostPathForServicePath = async (_id: string, value: string) => value === f.global ? mapped : value
        }
        let submitted = 0
        await assert.rejects(f.dispatch(plan, () => { submitted++ }), `${action}/${change}`)
        assert.equal(submitted, 0)
        assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
        assert.ok(!f.state.rpc.some(method => method === "attachHost" || method === "installHost"))
        assert.equal(await readFile(f.file, "utf8"), change === "document" ? before + "// external edit\n" : before)
      } finally { await chmod(f.file, originalMode); await f.cleanup() }
    }
  }
})

test("same plugin and offer cannot preserve attach/host/update plans across runtime target, source type or version replacement", async () => {
  for (const action of ["attach", "installHost", "update"] as const) {
    for (const change of ["target", "type", "version", "duplicateID"] as const) {
      const f = await fixture(true)
      try {
        f.state.status.host = { state: "absent", action: "install" }
        const plan = await f.prepare(runtimeAction(action))
        if (change === "target") f.state.runtime[0].source.target = "@neuralnomads/opencode-fixture@^0.2"
        else if (change === "type") f.state.runtime[0].source = { type: "local", path: path.join(f.root, "replacement.mjs") }
        else if (change === "version") f.state.runtime[0].source.version = "0.2.0"
        else f.state.runtime.push({ ...f.state.runtime[0], source: { type: "package", target: `${f.entry.package}@^0.2`, version: "0.2.0" } })
        let submitted = 0
        await assert.rejects(f.dispatch(plan, () => { submitted++ }), `${action}/${change}`)
        assert.equal(submitted, 0); assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
        assert.ok(!f.state.rpc.some(method => method === "attachHost" || method === "installHost"))
      } finally { await f.cleanup() }
    }
  }
})

test("Global confirmations refuse Project-only native declarations, inherited/inline sources, duplicate provenance and raw mismatches", async () => {
  for (const action of ["attach", "installHost", "update", "setActive"] as const) {
    for (const provenance of ["project", "inherited", "inline", "duplicate", "unconfigured", "rawMismatch"] as const) {
      const f = await fixture(true)
      try {
        f.state.status.host = { state: "absent", action: "install" }
        if (provenance === "project" || provenance === "inherited" || provenance === "duplicate") {
          const directory = path.join(provenance === "inherited" ? f.root : f.project, ".opencode")
          await mkdir(directory, { recursive: true })
          const file = path.join(directory, "opencode.jsonc")
          await writeFile(file, JSON.stringify({ plugins: [f.spec] }))
          f.state.documentPaths.push(file)
          if (provenance !== "duplicate") await writeFile(f.file, '{"plugins":[]}\n')
        } else if (provenance === "inline") {
          await writeFile(f.file, '{"plugins":[]}\n')
          f.state.configEntries = [{ type: "directory", path: f.global }, { type: "document", info: { plugins: [f.spec] } }]
        } else if (provenance === "rawMismatch") {
          f.state.configEntries = [{ type: "directory", path: f.global }, { type: "document", path: f.file, info: { plugins: [f.spec] } }]
          await writeFile(f.file, '{"plugins":["unrelated-package"]}\n')
        } else await writeFile(f.file, '{"plugins":[]}\n')
        const before = await readFile(f.file, "utf8")
        await assert.rejects(f.prepare(action === "setActive" ? { action, integration: "fixture", scope: "global", active: false }
          : runtimeAction(action)), `${action}/${provenance}`)
        assert.equal(await readFile(f.file, "utf8"), before)
        assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
        assert.ok(!f.state.rpc.some(method => method === "attachHost" || method === "installHost"))
      } finally { await f.cleanup() }
    }
  }
})

test("Global declaration in opencode.json remains manageable with a separate empty opencode.jsonc write target", async () => {
  for (const action of ["attach", "installHost", "update", "disable", "enable"] as const) {
    const f = await fixture(true)
    try {
      const declaration = await splitGlobalDocuments(f), original = await readFile(declaration, "utf8")
      if (action === "enable") await writeFile(f.file, '{"plugins":["-neuralnomads.fixture"]}\n')
      f.state.status.host = { state: "absent", action: "install" }
      const snapshot = await f.controls.read("w", f.context.location)
      assert.equal(snapshot.configured.sources[0]!.path, declaration)
      assert.equal(snapshot.targets.find(target => target.scope === "global")!.path, f.file)
      const plan = await f.prepare(action === "enable" || action === "disable"
        ? { action: "setActive", integration: "fixture", scope: "global", active: action === "enable" } : runtimeAction(action))
      let submitted = 0
      await f.dispatch(plan, () => { submitted++ })
      assert.equal(submitted, 1); assert.equal(plan.display.scope, "global")
      assert.equal(await readFile(declaration, "utf8"), original, "the actual declaration stays intact")
      assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins,
        action === "disable" ? ["-neuralnomads.fixture"] : action === "enable" ? ["-neuralnomads.fixture", "neuralnomads.fixture"] : [])
      assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target, "own activation/update/metadata effects keep authority")
    } finally { await f.cleanup() }
  }
})

test("dual-document plans independently pin declaration and write-target bytes and modes before submission", async () => {
  for (const action of ["attach", "installHost", "update", "setActive"] as const) {
    for (const role of ["declaration", "writeTarget"] as const) {
      for (const change of ["bytes", "mode"] as const) {
        const f = await fixture(true)
        let file = f.file, originalMode = 0
        try {
          const declaration = await splitGlobalDocuments(f)
          file = role === "declaration" ? declaration : f.file
          originalMode = (await stat(file)).mode & 0o777
          f.state.status.host = { state: "absent", action: "install" }
          const plan = await f.prepare(action === "setActive" ? { action, integration: "fixture", scope: "global", active: false } : runtimeAction(action))
          if (change === "bytes") await writeFile(file, (await readFile(file, "utf8")) + "// foreign edit\n")
          else await chmod(file, originalMode ^ 0o200)
          let submitted = 0
          await assert.rejects(f.dispatch(plan, () => { submitted++ }), `${action}/${role}/${change}`)
          assert.equal(submitted, 0); assert.deepEqual(f.state.packageUpdates, []); assert.deepEqual(f.state.updates, [])
          assert.ok(!f.state.rpc.some(method => method === "attachHost" || method === "installHost"))
        } finally { if (originalMode) await chmod(file, originalMode); await f.cleanup() }
      }
    }
  }
})

test("separate-declaration activation tolerates its own runtime disappearance between fresh config reads", async () => {
  const f = await fixture(true)
  try {
    const declaration = await splitGlobalDocuments(f)
    const plan = await f.prepare({ action: "setActive", integration: "fixture", scope: "global", active: false })
    const list = f.context.connection.client.plugin.list
    let submitted = false, reads = 0
    f.context.connection.client.plugin.list = (async (...args: any[]) => {
      if (submitted && ++reads === 2) f.state.runtime = []
      return (list as any)(...args)
    }) as any
    await f.dispatch(plan, () => { submitted = true })
    assert.equal(submitted, true); assert.deepEqual(f.state.runtime, [])
    assert.deepEqual(parse(await readFile(declaration, "utf8")).plugins, [f.spec])
    assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, ["-neuralnomads.fixture"])
    assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
  } finally { await f.cleanup() }
})

test("separate declaration remains fenced after native submission, including attach metadata continuation", async () => {
  for (const action of ["attach", "installHost", "update"] as const) {
    const f = await fixture(true)
    try {
      const declaration = await splitGlobalDocuments(f)
      f.state.status.host = { state: "absent", action: "install" }
      const plan = await f.prepare(runtimeAction(action))
      const edit = async () => { await writeFile(declaration, (await readFile(declaration, "utf8")) + "// foreign after submission\n") }
      if (action === "update") f.state.onUpdate = edit
      else if (action === "installHost") f.state.onInstallHost = edit
      else f.state.onRpc = method => { if (method === "attachHost") return edit() }
      let submitted = 0
      await assert.rejects(f.dispatch(plan, () => { submitted++ }), NativeMutationUncertainError)
      assert.equal(submitted, 1); assert.deepEqual(f.state.updates, [])
      assert.equal(await readFile(f.file, "utf8"), '{"plugins":[]}\n', "the unrelated preferred write target is unchanged")
    } finally { await f.cleanup() }
  }
})

test("source-document reader requires fresh native provenance and an owned scope-local document", async () => {
  const f = await fixture(true)
  try {
    const declaration = await splitGlobalDocuments(f)
    const source = (await f.controls.read("w", f.context.location)).configured.sources[0]!
    const result = await f.controls.readSourceDocument("w", f.context.location, source, f.abort.signal)
    assert.equal(result.path, declaration); assert.deepEqual(result.document.plugins, [f.spec])
    for (const forged of [{ ...source, path: path.join(f.root, "private.txt") }, { ...source, entryIndex: 99 }, { ...source, target: "unrelated" }]) {
      await assert.rejects(f.controls.readSourceDocument("w", f.context.location, forged), (error: any) => error.kind === "forbidden")
    }
    const outside = path.join(f.root, "private.txt")
    await writeFile(outside, "not configuration: must not be parsed")
    f.state.configEntries = [{ type: "directory", path: f.global }, { type: "document", path: outside, info: { plugins: [f.spec] } }]
    const nonCandidate = (await f.controls.read("w", f.context.location)).configured.sources[0]!
    await assert.rejects(f.controls.readSourceDocument("w", f.context.location, nonCandidate), (error: any) => error.kind === "forbidden")
    const explicit = path.join(f.global, "explicit-config.jsonc")
    await writeFile(explicit, JSON.stringify({ plugins: [f.spec] }))
    f.state.configEntries = [{ type: "directory", path: f.global }, { type: "document", path: explicit, info: { plugins: [f.spec] } }]
    const reported = (await f.controls.read("w", f.context.location)).configured.sources[0]!
    assert.equal((await f.controls.readSourceDocument("w", f.context.location, reported)).path, explicit,
      "native-authorized configuration documents are independent of preferred write-target filenames")
    f.state.configEntries = undefined
    f.state.documentPaths = [f.file]
    await assert.rejects(f.controls.readSourceDocument("w", f.context.location, source), (error: any) => error.kind === "forbidden",
      "a raw source remaining on disk cannot authorize a withdrawn native entry")
  } finally { await f.cleanup() }
})

test("non-native updates use their actual writable scope and refuse inherited documents in that same scope", async () => {
  for (const inherited of [false, true]) {
    const f = await fixture(true)
    try {
      f.state.catalog.integrations[0]!.family = "api"; delete f.state.catalog.integrations[0]!.host
      await writeFile(f.file, '{"plugins":[]}\n')
      const directory = path.join(inherited ? f.root : f.project, ".opencode")
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, "opencode.jsonc")
      await writeFile(file, JSON.stringify({ plugins: [f.spec] }))
      f.state.documentPaths.push(file)
      await assert.rejects(f.prepare({ action: "update", integration: "fixture", scope: "global" }))
      const preparation = f.prepare({ action: "update", integration: "fixture", scope: "project" })
      if (inherited) { await assert.rejects(preparation); assert.deepEqual(f.state.packageUpdates, []) }
      else {
        const plan = await preparation
        assert.equal(plan.display.scope, "project")
        await f.dispatch(plan); assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
        assert.equal(f.state.packageUpdates.length, 1)
      }
    } finally { await f.cleanup() }
  }
})

test("post-submission document/provenance replacement remains uncertain and stops attach metadata", async () => {
  for (const action of ["attach", "installHost", "update"] as const) {
    for (const change of ["document", "target", "type", "mode", "version", "provenance"] as const) {
      const f = await fixture(true), originalMode = (await stat(f.file)).mode & 0o777
      try {
        f.state.status.host = { state: "absent", action: "install" }
        const plan = await f.prepare(runtimeAction(action))
        const replace = async () => {
          if (change === "document") await writeFile(f.file, (await readFile(f.file, "utf8")) + "// external after submission\n")
          else if (change === "target") f.state.runtime[0].source.target += "-replacement"
          else if (change === "type") f.state.runtime[0].source = { type: "local", path: path.join(f.root, "replacement.mjs") }
          else if (change === "mode") await chmod(f.file, originalMode ^ 0o200)
          else if (change === "version") f.state.runtime[0].source.version = action === "update" ? "C:private-version" : "0.2.0"
          else f.state.configEntries = [{ type: "directory", path: f.global },
            { type: "document", path: path.join(f.project, "opencode.jsonc"), info: { plugins: [f.spec] } }]
        }
        if (action === "update") f.state.onUpdate = replace
        else if (action === "installHost") f.state.onInstallHost = replace
        else f.state.onRpc = method => { if (method === "attachHost") return replace() }
        let submitted = 0
        await assert.rejects(f.dispatch(plan, () => { submitted++ }), NativeMutationUncertainError)
        assert.equal(submitted, 1)
        assert.deepEqual(f.state.updates, [], "a changed binding/configuration cannot authorize the metadata continuation")
        assert.equal(action === "update" ? f.state.packageUpdates.length : f.state.rpc.filter(method => method === (action === "attach" ? "attachHost" : "installHost")).length, 1)
      } finally { await chmod(f.file, originalMode); await f.cleanup() }
    }
  }
})

test("attach revalidates every offer detail and observes binding plus metadata submission only once", async () => {
  for (const change of ["none", "label", "document", "appVersion", "protocol", "gone"] as const) {
    const f = await fixture(true)
    try {
      const plan = await f.prepare({ action: "attach", integration: "fixture", offerID: "offer_fixture" })
      if (change === "gone") f.state.offers = []
      else if (change !== "none") f.state.offers[0]![change] = change === "protocol" ? "incompatible" : "changed"
      let submitted = 0
      const work = f.dispatch(plan, () => { submitted++ })
      if (change !== "none") { await assert.rejects(work); assert.equal(submitted, 0); assert.equal(f.state.updates.length, 0) }
      else {
        await work; assert.equal(submitted, 1); assert.equal(f.state.updates.length, 1)
        assert.equal(f.state.metadata.unrelated, true)
        assert.deepEqual(f.state.rpc.filter(method => method === "attachHost"), ["attachHost"])
      }
      assert.ok(f.catalogReads.every(options => (options as any)?.refresh === false))
    } finally { await f.cleanup() }
  }
})

test("revocation after binding submission is uncertain and blocks metadata; direct detach targets only captured session", async () => {
  const f = await fixture(true)
  try {
    const plan = await f.prepare({ action: "attach", integration: "fixture", offerID: "offer_fixture" })
    f.state.onRpc = method => { if (method === "attachHost") f.abort.abort() }
    let submitted = 0
    await assert.rejects(f.dispatch(plan, () => { submitted++ }), NativeMutationUncertainError)
    assert.equal(submitted, 1); assert.equal(f.state.updates.length, 0)
  } finally { await f.cleanup() }
  const other = await fixture(true)
  try {
    assert.deepEqual(await other.actions.detach(other.context, "fixture", other.abort.signal), { outcome: "detached" })
    assert.equal((other.state.updates[0] as any).sessionID, "ses_fixture")
    other.state.session = "ses_other"
    await assert.rejects(other.actions.detach(other.context, "fixture", other.abort.signal))
    assert.equal(other.state.rpc.filter(method => method === "detachHost").length, 1)
  } finally { await other.cleanup() }
})

test("lifecycle plus real builder completes own config change; no-op activation emits failed without fabricated submission", async () => {
  for (const noOp of [false, true]) {
    const f = await fixture(true), ready = deferred(), done = deferred(), events: any[] = []
    let now = 0, view: BundlesConfirmation | null = null
    const lifecycle = new BundlesLifecycle({ now: () => now, setTimeout: () => ({}), clearTimeout() {} })
    try {
      if (noOp) await writeFile(f.file, JSON.stringify({ plugins: [f.spec, "-neuralnomads.fixture"] }) + "\n")
      const owner = lifecycle.mount({ extension: "fixture.panel", digest: "a".repeat(64), authority: f.context.authority, signal: f.abort.signal,
        show(value) { view = value; if (value) ready.resolve() }, changed(event) { events.push(event) } })
      const request = lifecycle.request(owner, async signal => {
        const plan = await f.actions.prepare(f.context, { action: "setActive", integration: "fixture", scope: "global", active: false }, signal)
        return { ...plan, async dispatch(...args) { try { await plan.dispatch(...args) } finally { done.resolve() } } }
      })
      request.afterAck(); await ready.promise
      lifecycle.displayed(owner, view!.planID); now = 600; lifecycle.confirm(owner, view!.planID)
      await done.promise
      // Let lifecycle settle its dispatch promise after the wrapped real service returns.
      await Promise.resolve(); await Promise.resolve()
      assert.equal(events.length, 1); assert.equal(events[0].outcome, noOp ? "failed" : "confirmed")
    } finally { lifecycle.dispose(); await f.cleanup() }
  }
})

test("confirmation strings contain only bounded safe display fields", async () => {
  const f = await fixture(true)
  try {
    f.state.title = "secret/absolute/path"; f.state.runtime[0].source.version = "C:secret"
    f.state.catalog.integrations[0]!.displayName = "OpenCode for /secret/path"
    const plan = await f.prepare({ action: "attach", integration: "fixture", offerID: "offer_fixture" })
    assert.equal(plan.display.integration, "fixture"); assert.equal(plan.display.version, f.entry.range)
    assert.equal(plan.display.conversation, "ses_fixture"); assert.equal(plan.display.document, "Fixture window — Scene.blend")
    assert.ok(!JSON.stringify(plan.display).includes(f.root)); assert.ok(!JSON.stringify(plan.display).includes(plan.target.documentDigest))
    f.state.title = "x".repeat(500)
    assert.equal((await f.prepare({ action: "update", integration: "fixture", scope: "global" })).display.conversation.length, 120)
  } finally { await f.cleanup() }
})

test("management attach completes under controlled session latency with bounded reads", { timeout: 25_000 }, async t => {
  const f = await fixture(true), ready = deferred(), done = deferred(), frames: any[] = []
  let now = 0, measuring = false, sessions = 0, mountChecks = 0, targets = 0, elapsed = 0, failure: unknown
  const get = f.context.connection.client.session.get
  f.context.connection.client.session.get = (async (...args: any[]) => {
    if (measuring) { sessions++; await delay(10, undefined, { signal: args[1]?.signal }) }
    return (get as any)(...args)
  }) as any
  const lifecycle = new BundlesLifecycle({ now: () => now, setTimeout, clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout) })
  const transport = new BundlesTransport({ lifecycle, eventBus: new EventBus(), workspaceManager: f.manager, catalog: f.catalog,
    auth: { getSessionFromRequest: () => ({ sessionId: "human", username: "human" }) },
    store: { async captureReadAuthority() { return { canManage: true, signal: f.abort.signal,
      assertCurrent: () => f.abort.signal.throwIfAborted(), async revalidate() { f.abort.signal.throwIfAborted() }, dispose() {} } } },
    actions: { accepts: action => f.actions.accepts(action), async prepare(context, action, signal) {
      const revalidate = context.authority.revalidate.bind(context.authority)
      context.authority.revalidate = async () => { if (measuring) mountChecks++; return revalidate() }
      const prepared = await f.actions.prepare(context, action, signal)
      return { ...prepared, async readTarget(signal) { if (measuring) targets++; return prepared.readTarget(signal) },
        async dispatch(...args) {
          measuring = true; const start = performance.now()
          try { await prepared.dispatch(...args) } catch (error) { failure = error; throw error }
          finally { elapsed = performance.now() - start; measuring = false; done.resolve() }
        } }
    } },
  })
  const request = {} as any, extension = "test.bundles"
  transport.openStream(request, {}, text => { const value = JSON.parse(text.split("data: ")[1]); frames.push(value); if (value.view) ready.resolve() })
  try {
    const owner = frames[0].owner
    const mounted = { owner, ...await transport.mount(request, extension,
      { owner, digest: "a".repeat(64), instanceId: "w", sessionID: "ses_fixture" }, AbortSignal.timeout(1000)) }
    const ack = await transport.manage(request, extension, { ...mounted, method: "attach", input: { integration: "fixture", offerID: "offer_fixture" } })
    assert.equal(ack.outcome, "confirming"); if (ack.outcome !== "confirming") return
    await transport.control(request, extension, { ...mounted, command: "start", requestID: ack.requestID }); await ready.promise
    const view = frames.find(event => event.view).view
    await transport.control(request, extension, { ...mounted, command: "displayed", planID: view.planID }); now = 600
    f.state.rpc.length = 0
    await transport.control(request, extension, { ...mounted, command: "confirm", planID: view.planID }); await done.promise
    t.diagnostic(JSON.stringify({ elapsed: Math.round(elapsed), targets, mountChecks, sessions,
      attach: f.state.rpc.filter(method => method === "attachHost").length, q8: f.state.updates.length }))
    assert.equal(failure, undefined, "Actual dispatch completes within the unchanged default eight-second service deadline")
    assert.ok(elapsed < 8_000); assert.ok(targets <= 40, `target reads: ${targets}`)
    assert.ok(mountChecks <= 200, `mount checks: ${mountChecks}`); assert.ok(sessions <= 260, `session reads: ${sessions}`)
    assert.equal(f.state.rpc.filter(method => method === "attachHost").length, 1); assert.equal(f.state.updates.length, 1)
    assert.equal(f.state.metadata.unrelated, true)
    await assert.rejects(transport.control(request, extension, { ...mounted, command: "confirm", planID: view.planID }))
    assert.equal(f.state.updates.length, 1); assert.equal(frames.filter(event => event.change?.requestID === ack.requestID).length, 1)
  } finally { transport.dispose(); await f.cleanup() }
})

test("confirmed removal uses the same snapshot revision, exact object entry and shared native writer without status or cleanup", async () => {
  for (const staleCatalog of [false, true]) {
    const f = await fixture(true)
    try {
      const text = '\uFEFF{\r\n // retained\r\n "plugins": ["unrelated", {"package":' + JSON.stringify(f.spec)
        + ',"options":{"secret":"PRIVATE_OPTIONS"}}, "-neuralnomads.fixture"], "keep":true\r\n}\r\n'
      await writeFile(f.file, text)
      f.state.metadata = { foreign: "PRIVATE_FOREIGN_SESSION", attachment: "PRIVATE_Q8" }
      f.state.status = { deliberately: "PRIVATE_BROKEN_STATUS" }
      if (staleCatalog) f.catalog.snapshot = () => ({ state: "stale" as any, catalog: f.state.catalog })
      const expectedRevision = (await f.controls.read("w", f.context.location)).targets.find(target => target.scope === "global")!.expectedRevision
      const original = f.sources.remove.bind(f.sources), received: unknown[] = []
      f.sources.remove = async (...args) => { received.push(args[1]); return original(...args) }
      const plan = await f.prepare({ action: "remove", integration: "fixture", scope: "global" })
      assert.ok(!JSON.stringify(plan.display).includes("PRIVATE_")); assert.equal(plan.display.action, "remove")
      let submitted = 0
      await f.dispatch(plan, () => { submitted++ })
      assert.equal(submitted, 1)
      assert.deepEqual(received, [{ location: f.context.location, scope: "global", target: f.spec, entryIndex: 1, expectedRevision }])
      assert.deepEqual(parse(await readFile(f.file, "utf8")), { plugins: ["unrelated", "-neuralnomads.fixture"], keep: true })
      assert.ok((await readFile(f.file, "utf8")).startsWith('\uFEFF{\r\n // retained'))
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
      assert.deepEqual(f.state.metadata, { foreign: "PRIVATE_FOREIGN_SESSION", attachment: "PRIVATE_Q8" })
      // A still-loaded runtime and the watcher's stale native declaration never masquerade as removal authority.
      assert.equal(f.state.runtime.length, 1); assert.deepEqual(await plan.readTarget(f.abort.signal), plan.target)
      assert.ok(f.catalogReads.every(options => (options as any)?.refresh === false))
    } finally { await f.cleanup() }
  }
})

test("removal refuses absent, ambiguous, multiple, inherited, inline and nonpreferred declarations, never first-candidate guessing", async () => {
  for (const variant of ["absent", "ambiguous", "multiple", "inherited", "inline", "nonpreferred", "unavailable"] as const) {
    const f = await fixture(true)
    try {
      if (variant === "absent") await writeFile(f.file, '{"plugins":[]}')
      else if (variant === "multiple") await writeFile(f.file, JSON.stringify({ plugins: [f.spec, f.spec + "0"] }))
      else if (variant === "nonpreferred") await splitGlobalDocuments(f)
      else if (variant === "ambiguous") f.state.runtime[0].id = "foreign.plugin"
      else if (variant === "inline") {
        await writeFile(f.file, '{"plugins":[]}')
        f.state.configEntries = [{ type: "directory", path: f.global }, { type: "document", info: { plugins: [f.spec] } }]
      } else if (variant === "inherited") {
        const file = path.join(f.root, "opencode.jsonc")
        await writeFile(file, JSON.stringify({ plugins: [f.spec] })); await writeFile(f.file, '{"plugins":[]}')
        f.state.documentPaths.push(file)
      } else f.catalog.snapshot = () => ({ state: "unavailable" as any, catalog: f.state.catalog })
      const before = await readFile(f.file, "utf8")
      await assert.rejects(f.prepare({ action: "remove", integration: "fixture", scope: "global" }), variant)
      assert.equal(await readFile(f.file, "utf8"), before)
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, [])
    } finally { await f.cleanup() }
  }
})

test("removal plans reject full-entry/options, bytes, mode, destination, catalogue/range, identity and source-index drift before submission", async () => {
  for (const change of ["options", "bytes", "mode", "destination", "range", "source", "index", "session", "location", "connection", "revoke"] as const) {
    const f = await fixture(true), mode = (await stat(f.file)).mode & 0o777
    try {
      await writeFile(f.file, JSON.stringify({ plugins: [{ package: f.spec, options: { secret: "PRIVATE_BEFORE" } }] }))
      const plan = await f.prepare({ action: "remove", integration: "fixture", scope: "global" })
      if (change === "options") await writeFile(f.file, JSON.stringify({ plugins: [{ package: f.spec, options: { secret: "PRIVATE_AFTER" } }] }))
      else if (change === "bytes") await writeFile(f.file, (await readFile(f.file, "utf8")) + "\n")
      else if (change === "mode") await chmod(f.file, mode ^ 0o200)
      else if (change === "destination") f.state.globalDirectory = f.project
      else if (change === "range") f.state.catalog.integrations[0]!.range = "^0.2"
      else if (change === "source") await writeFile(f.file, JSON.stringify({ plugins: [f.spec + "0"] }))
      else if (change === "index") await writeFile(f.file, JSON.stringify({ plugins: ["unrelated", f.spec] }))
      else if (change === "session") f.state.session = "ses_replaced"
      else if (change === "location") f.state.directory = f.global
      else if (change === "connection") f.state.current = false
      else f.abort.abort()
      const before = await readFile(f.file, "utf8"); let submitted = 0
      await assert.rejects(f.dispatch(plan, () => { submitted++ }), change)
      assert.equal(submitted, 0); assert.equal(await readFile(f.file, "utf8"), before)
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, [])
    } finally { await chmod(f.file, mode); await f.cleanup() }
  }
})

test("removal revalidates after the real config queue wait and preserves postdispatch uncertainty without replay", async () => {
  for (const stage of ["queue", "prepared", "postdispatch"] as const) {
    const f = await fixture(true), entered = deferred(), release = deferred()
    try {
      const plan = await f.prepare({ action: "remove", integration: "fixture", scope: "global" })
      let submitted = 0
      if (stage === "queue") {
        const first = f.controls.editConfigDocument("w", f.context.location, "global", async document => { entered.resolve(); await release.promise; return document.text })
        await entered.promise
        const work = f.dispatch(plan, () => { submitted++ }), rejected = assert.rejects(work)
        f.abort.abort(); release.resolve(); await first; await rejected
      } else {
        f.state.onAuthorize = async () => {
          const names = await readdir(f.global)
          if (stage === "prepared" && names.some(name => name.endsWith(".tmp"))) f.abort.abort()
          if (stage === "postdispatch" && parse(await readFile(f.file, "utf8")).plugins.length === 0) f.abort.abort()
        }
        await assert.rejects(f.dispatch(plan, () => { submitted++ }), error => stage !== "postdispatch" || error instanceof NativeMutationUncertainError)
      }
      assert.equal(submitted, stage === "postdispatch" ? 1 : 0)
      assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, stage === "postdispatch" ? [] : [f.spec])
      assert.deepEqual(await readdir(f.global), ["opencode.jsonc"])
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, [])
    } finally { release.resolve(); await f.cleanup() }
  }
})

test("removal confirms only after observed source removal; a lost acknowledgement emits failed once after submission", async () => {
  for (const lost of [false, true]) {
    const f = await fixture(true), ready = deferred(), reached = deferred(), release = deferred(), done = deferred(), events: any[] = []
    let now = 0, view: BundlesConfirmation | null = null
    const lifecycle = new BundlesLifecycle({ now: () => now, setTimeout: () => ({}), clearTimeout() {} })
    try {
      const remove = f.sources.remove.bind(f.sources)
      f.sources.remove = async (...args) => { const result = await remove(...args); reached.resolve(); await release.promise; if (lost) throw new Error("PRIVATE_LOST_ACK"); return result }
      const owner = lifecycle.mount({ extension: "fixture.panel", digest: "a".repeat(64), authority: f.context.authority, signal: f.abort.signal,
        show(value) { view = value; if (value) ready.resolve() }, changed(event) { events.push(event); done.resolve() } })
      const request = lifecycle.request(owner, signal => f.actions.prepare(f.context, { action: "remove", integration: "fixture", scope: "global" }, signal))
      request.afterAck(); await ready.promise
      const planID = view!.planID
      lifecycle.displayed(owner, planID); now = 600; await lifecycle.confirmChecked(owner, planID)
      await reached.promise
      assert.equal(events.length, 0, "submission alone is not removal success")
      assert.deepEqual(parse(await readFile(f.file, "utf8")).plugins, [])
      release.resolve(); await done.promise
      assert.equal(events.length, 1); assert.equal(events[0].outcome, lost ? "failed" : "confirmed")
      await assert.rejects(lifecycle.confirmChecked(owner, planID)); assert.equal(events.length, 1)
    } finally { release.resolve(); lifecycle.dispose(); await f.cleanup() }
  }
})

async function removeForReinstall(f: Awaited<ReturnType<typeof fixture>>, rules: string[] = []) {
  const unrelated = '{"package":"unrelated-package","options":{"keep":"PRIVATE_UNRELATED","nested":[1,true]}}'
  const text = '\uFEFF{\r\n // retain comment and options\r\n "plugins": [\r\n  ' + unrelated
    + ',\r\n  {"package":' + JSON.stringify(f.spec) + ',"options":{"removed":"PRIVATE_REMOVED"}}'
    + ',\r\n  "retained-package"'
    + rules.map(rule => ',\r\n  ' + JSON.stringify(rule)).join("") + '\r\n ],\r\n "keep": {"value":42}\r\n}\r\n'
  await writeFile(f.file, text)
  const snapshot = await f.controls.read("w", f.context.location)
  const revision = snapshot.targets.find(target => target.scope === "global")!.expectedRevision
  await f.sources.remove("w", { location: f.context.location, scope: "global", target: f.spec, entryIndex: 1, expectedRevision: revision! })
  const retained = await readFile(f.file, "utf8")
  assert.deepEqual(parse(retained), { plugins: [JSON.parse(unrelated), "retained-package", ...rules], keep: { value: 42 } })
  assert.ok(retained.startsWith('\uFEFF{\r\n // retain comment and options\r\n'))
  assert.ok(retained.includes(unrelated)); assert.ok(!retained.includes("PRIVATE_REMOVED"))
  assert.ok(!retained.replaceAll("\r\n", "").includes("\n"))
  f.state.runtime = [] // The native reload has unloaded the removed package.
  return { retained, unrelated }
}

async function reinstallConfirmation(f: Awaited<ReturnType<typeof fixture>>) {
  const ready = deferred(), finished = deferred(), events: any[] = []
  let now = 0, view: BundlesConfirmation | null = null, failure: unknown
  const lifecycle = new BundlesLifecycle({ now: () => now, setTimeout: () => ({}), clearTimeout() {} })
  const owner = lifecycle.mount({ extension: "fixture.panel", digest: "a".repeat(64), authority: f.context.authority, signal: f.abort.signal,
    show(value) { if (value) { view = value; ready.resolve() } }, changed(event) { events.push(event); ready.resolve() } })
  const request = lifecycle.request(owner, async signal => {
    const plan = await f.actions.prepare(f.context, { action: "install", integration: "fixture", scope: "global" }, signal)
    return { ...plan, async dispatch(...args) {
      try { await plan.dispatch(...args) } catch (error) { failure = error; throw error } finally { finished.resolve() }
    } }
  })
  assert.equal(request.ack.outcome, "confirming")
  request.afterAck(); await ready.promise
  const shown = view as BundlesConfirmation | null
  if (!shown) lifecycle.dispose()
  assert.ok(shown, `reinstall must reach confirmation, got ${JSON.stringify(events)}`)
  return { lifecycle, owner, view: shown, events, request, get failure() { return failure },
    async confirm() { lifecycle.displayed(owner, shown.planID); now = 600; await lifecycle.confirmChecked(owner, shown.planID) },
    async settled() { await finished.promise; await Promise.resolve(); await Promise.resolve() } }
}

test("reinstall after exact removal preserves retained normalized rules, BOM, CRLF, comments and unrelated options", async t => {
  for (const variant of ["disabled", "positiveOnly", "disableEnable", "noRules"] as const) await t.test(variant, async () => {
    const f = await fixture(true)
    let confirmation: Awaited<ReturnType<typeof reinstallConfirmation>> | undefined
    try {
      const id = f.entry.plugin, rules = variant === "disabled" ? [`-${id}`] : variant === "positiveOnly" ? [id]
        : variant === "disableEnable" ? [`-${id}`, id] : []
      if (variant === "positiveOnly") {
        // A lone non-builtin ID is otherwise a source. Earlier discovery establishes this exact ID as a rule.
        const earlier = path.join(f.global, "opencode.json")
        await writeFile(earlier, JSON.stringify({ plugins: [`-${id}`] }) + "\n")
        f.state.documentPaths = [earlier, f.file]
      }
      const { retained, unrelated } = await removeForReinstall(f, rules)
      const before = await f.controls.read("w", f.context.location)
      const recognition = recognizeIntegrations(f.state.catalog, before)[0]!
      assert.deepEqual(recognition.sources, []); assert.equal(recognition.runtime, undefined); assert.equal(recognition.ambiguous, false)
      const expectedRules = variant === "positiveOnly" ? [false, true] : variant === "disabled" ? [false] : variant === "disableEnable" ? [false, true] : []
      assert.deepEqual(before.configured.rules.filter(rule => rule.selector === id).map(rule => rule.enabled), expectedRules)
      if (variant === "positiveOnly") assert.equal(before.configured.rules.at(-1)!.path, f.file)
      const document = (await f.controls.readConfigDocuments("w", f.context.location)).documents.find(target => target.scope === "global")!.document
      const expected = appendPluginControlRule(document, f.spec)
      confirmation = await reinstallConfirmation(f)
      await confirmation.confirm(); await confirmation.settled()
      assert.equal(confirmation.failure, undefined); assert.deepEqual(confirmation.events.map(event => event.outcome), ["confirmed"])
      const after = await readFile(f.file, "utf8")
      assert.equal(after, expected, "install makes only the exact shared append edit to the captured document")
      assert.deepEqual(parse(after), { plugins: [JSON.parse(unrelated), "retained-package", ...rules, f.spec], keep: { value: 42 } })
      const snapshot = await f.controls.read("w", f.context.location)
      assert.deepEqual(snapshot.configured.rules, before.configured.rules, "install neither rewrites nor appends activation rules")
      assert.equal(recognizeIntegrations(f.state.catalog, snapshot)[0]!.sources.length, 1)
      assert.deepEqual(snapshot.runtime, [], "a durable source declaration does not fabricate a loaded plugin")
      assert.notEqual(after, retained); assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
    } finally { confirmation?.lifecycle.dispose(); await f.cleanup() }
  })
})

test("ordinary Plugins disable/enable, exact removal and reinstall retain the actual ordered rules", async () => {
  const f = await fixture(true)
  try {
    const id = "example.ordinary", spec = "ordinary-plugin@^1", unrelated = { package: "unrelated-package", options: { keep: true } }
    f.state.runtime[0].id = id
    f.state.runtime[0].source = { type: "package", target: spec, version: "1.0.0" }
    await writeFile(f.file, '\uFEFF{\r\n // ordinary plugin options\r\n "plugins": [' + JSON.stringify(unrelated)
      + ', {"package":' + JSON.stringify(spec) + ',"options":{"removed":true}}, "retained-package"], "keep":42\r\n}\r\n')
    for (const enabled of [false, true]) {
      const result = await f.controls.mutate("w", { location: f.context.location, scope: "global", pluginId: id, enabled })
      assert.equal(result.changed, true)
    }
    const selected = await f.controls.read("w", f.context.location)
    assert.deepEqual(selected.configured.rules.map(rule => [rule.selector, rule.enabled]), [[id, false], [id, true]])
    assert.ok(recognizeIntegrations(f.state.catalog, selected).every(entry => entry.sources.length === 0 && entry.runtime === undefined))
    const source = selected.configured.sources.find(source => source.target === spec)!
    await f.sources.remove("w", { location: f.context.location, scope: "global", target: spec, entryIndex: source.entryIndex,
      expectedRevision: selected.targets.find(target => target.scope === "global")!.expectedRevision! })
    f.state.runtime = []
    const document = (await f.controls.readConfigDocuments("w", f.context.location)).documents.find(target => target.scope === "global")!.document
    assert.deepEqual(document.plugins, [unrelated, "retained-package", `-${id}`, id])
    await f.sources.add("w", { location: f.context.location, scope: "global", spec })
    assert.equal(await readFile(f.file, "utf8"), appendPluginControlRule(document, spec))
    const snapshot = await f.controls.read("w", f.context.location)
    assert.deepEqual(snapshot.configured.rules.map(rule => [rule.selector, rule.enabled]), [[id, false], [id, true]])
    assert.equal(snapshot.configured.sources.filter(source => source.target === spec).length, 1)
    assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
  } finally { await f.cleanup() }
})

test("reinstall refuses existing disabled or inherited declarations, unknown ambiguous sources and remaining runtime", async t => {
  for (const variant of ["disabled", "inherited", "unknownAmbiguous", "activeRuntime", "failedRuntime", "ambiguousRuntime"] as const) await t.test(variant, async () => {
    const f = await fixture(true)
    try {
      if (variant === "activeRuntime" || variant === "failedRuntime" || variant === "ambiguousRuntime") {
        const runtime = f.state.runtime[0]
        await removeForReinstall(f)
        runtime.state = variant === "failedRuntime" ? { status: "failed", error: "PRIVATE_RUNTIME_ERROR" } : { status: "active" }
        f.state.runtime = [runtime]
        if (variant === "ambiguousRuntime") f.state.runtime.push({ ...runtime, source: { type: "package", target: "unknown-package", version: "0.1.0" } })
      } else {
        f.state.runtime = []
        if (variant === "disabled") await writeFile(f.file, JSON.stringify({ plugins: [f.spec, `-${f.entry.plugin}`] }))
        else if (variant === "inherited") {
          const inherited = path.join(f.root, "opencode.jsonc")
          await writeFile(inherited, JSON.stringify({ plugins: [f.spec] })); await writeFile(f.file, '{"plugins":[]}')
          f.state.documentPaths.push(inherited)
        } else {
          const unknown = "git+https://github.com/fixture/unknown.git"
          f.state.catalog = catalogOf({ ...f.entry, sources: { git: [unknown] } }, catalogEntry("other", { sources: { git: [unknown] } }))
          await writeFile(f.file, JSON.stringify({ plugins: [unknown] }))
        }
      }
      const recognition = recognizeIntegrations(f.state.catalog, await f.controls.read("w", f.context.location))[0]!
      if (variant === "unknownAmbiguous") assert.equal(recognition.ambiguous, true)
      else if (variant === "ambiguousRuntime") {
        assert.equal(recognition.sources.length, 0); assert.equal(recognition.runtime, undefined); assert.equal(recognition.ambiguous, true)
      }
      else if (variant.endsWith("Runtime")) { assert.equal(recognition.sources.length, 0); assert.ok(recognition.runtime) }
      else { assert.equal(recognition.sources.length, 1); assert.equal(recognition.runtime, undefined) }
      const before = await readFile(f.file, "utf8")
      await assert.rejects(f.prepare({ action: "install", integration: "fixture", scope: "global" }))
      assert.equal(await readFile(f.file, "utf8"), before)
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
    } finally { await f.cleanup() }
  })
})

test("reinstall confirmation binds options, index, content, mode, destination, connection, catalogue and revocation", async t => {
  for (const change of ["options", "index", "content", "mode", "destination", "connection", "catalogue", "revoke"] as const) await t.test(change, async () => {
    const f = await fixture(true), mode = (await stat(f.file)).mode & 0o777
    let confirmation: Awaited<ReturnType<typeof reinstallConfirmation>> | undefined
    try {
      await removeForReinstall(f)
      confirmation = await reinstallConfirmation(f)
      let adds = 0
      const add = f.sources.add.bind(f.sources)
      f.sources.add = (...args) => { adds++; return add(...args) }
      const retained = await readFile(f.file, "utf8")
      if (change === "options") await writeFile(f.file, retained.replace("PRIVATE_UNRELATED", "PRIVATE_CHANGED"))
      else if (change === "index") await writeFile(f.file, retained.replace('"plugins": [', '"plugins": ["another-package",'))
      else if (change === "content") await writeFile(f.file, retained + "// external comment\r\n")
      else if (change === "mode") await chmod(f.file, mode ^ 0o200)
      else if (change === "destination") f.state.globalDirectory = f.project
      else if (change === "connection") f.manager.getSharedServiceConnection = async () => ({ ...f.context.connection })
      else if (change === "catalogue") f.state.catalog.integrations[0]!.range = "^0.2"
      else f.abort.abort()
      const before = await readFile(f.file, "utf8")
      await assert.rejects(confirmation.confirm())
      await assert.rejects(confirmation.lifecycle.confirmChecked(confirmation.owner, confirmation.view.planID), "consumed stale plans cannot replay")
      assert.equal(adds, 0); assert.equal(await readFile(f.file, "utf8"), before)
      assert.deepEqual(confirmation.events.map(event => event.outcome), ["failed"])
      assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
    } finally { confirmation?.lifecycle.dispose(); await chmod(f.file, mode); await f.cleanup() }
  })
})

test("reinstall lost writer reply remains uncertain after real submission and lifecycle never replays the consumed plan", async () => {
  const f = await fixture(true)
  let confirmation: Awaited<ReturnType<typeof reinstallConfirmation>> | undefined
  try {
    await removeForReinstall(f)
    const edit = f.controls.editConfigDocument.bind(f.controls), add = f.sources.add.bind(f.sources)
    let writes = 0, adds = 0
    f.controls.editConfigDocument = async (...args) => {
      await edit(...args)
      writes++
      throw new Error("PRIVATE_LOST_WRITER_REPLY")
    }
    f.sources.add = (...args) => { adds++; return add(...args) }
    confirmation = await reinstallConfirmation(f)
    await confirmation.confirm(); await confirmation.settled()
    assert.ok(confirmation.failure instanceof NativeMutationUncertainError)
    // Install's confirmed event denotes transmission. The lost writer receipt still prevents claiming completion.
    assert.deepEqual(confirmation.events.map(event => event.outcome), ["confirmed"])
    assert.ok(!JSON.stringify(confirmation.events).includes("PRIVATE_"))
    const snapshot = await f.controls.read("w", f.context.location)
    assert.equal(recognizeIntegrations(f.state.catalog, snapshot)[0]!.sources.length, 1)
    assert.deepEqual(snapshot.runtime, [])
    assert.equal(parse(await readFile(f.file, "utf8")).plugins.filter((entry: unknown) => entry === f.spec).length, 1)
    await assert.rejects(confirmation.lifecycle.confirmChecked(confirmation.owner, confirmation.view.planID))
    confirmation.request.afterAck(); confirmation.lifecycle.confirm(confirmation.owner, confirmation.view.planID)
    await Promise.resolve()
    assert.equal(adds, 1); assert.equal(writes, 1); assert.equal(confirmation.events.length, 1)
    assert.deepEqual(f.state.rpc, []); assert.deepEqual(f.state.updates, []); assert.deepEqual(f.state.packageUpdates, [])
  } finally { confirmation?.lifecycle.dispose(); await f.cleanup() }
})
