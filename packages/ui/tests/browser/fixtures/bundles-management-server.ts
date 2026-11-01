import Fastify from "fastify"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { EventBus } from "../../../../server/src/events/bus"
import { PanelExtensionStore } from "../../../../server/src/panel-extensions/store"
import { readPanelExtensionArchive } from "../../../../server/src/panel-extensions/archive"
import { fixtureArchive } from "../../../../server/src/panel-extensions/archive-fixture"
import { BundlesActions } from "../../../../server/src/panel-extensions/bundles-actions"
import { BundlesTransport } from "../../../../server/src/panel-extensions/bundles-transport"
import { BundlesLifecycle } from "../../../../server/src/panel-extensions/bundles-lifecycle"
import { PluginControls } from "../../../../server/src/opencode/plugin-controls"
import { PluginSources } from "../../../../server/src/opencode/plugin-sources"
import { PluginPackages } from "../../../../server/src/opencode/plugin-packages"
import { IntegrationAttachments } from "../../../../server/src/opencode/integrations/attachments"
import { IntegrationsReader } from "../../../../server/src/opencode/integrations/integrations"
import { catalogEntry, catalogOf } from "../../../../server/src/opencode/integrations/catalog-fixture"
import { registerEventRoutes } from "../../../../server/src/server/routes/events"
import { registerPanelExtensionRoutes } from "../../../../server/src/server/routes/panel-extensions"
import { registerPanelExtensionBundlesManagementRoutes } from "../../../../server/src/server/routes/panel-extension-bundles-management"
import { registerPanelExtensionBundlesRoutes } from "../../../../server/src/server/routes/panel-extension-bundles"

const author = `<button id="trigger">Manage</button><button id="other">Other</button><p id="ready"></p><pre id="answer"></pre><pre id="reconciled"></pre><script>
  window.results=[]; window.changes=[]; window.messages=[]; window.reconciliations=[]; window.ackDurations=[];
  window.input={method:'attach',input:{integration:'fixture',offerID:'offer_fixture'}};
  window.call=(method,input)=>{const at=performance.now();return codenomad.bundles[method](input).then(value=>{
    ackDurations.push({method,ms:performance.now()-at});results.push(value);document.querySelector('#answer').textContent=JSON.stringify(value);return value;
  },error=>({error:error.message}));};
  document.querySelector('#trigger').onclick=()=>void call(window.input.method,window.input.input);
  window.readState=()=>codenomad.bundles.state().then(value=>{
    reconciliations.push(value);document.querySelector('#reconciled').textContent=JSON.stringify(value);return value;
  });
  codenomad.bundles.onChanged(value=>{changes.push(value);if(value.kind==='request'&&value.outcome==='confirmed')void readState().catch(()=>{});});
  codenomad.onContext(value=>document.querySelector('#ready').textContent=value.sessionId);
  addEventListener('message',event=>{if(event.data?.type==='codenomad:init'){
    window.rawPort=event.ports[0];rawPort.addEventListener('message',event=>messages.push(event.data));rawPort.start();
  }});
</script>`

/** Real Fastify routes, stream ownership, consent leases, builders and native service adapters.
 * Only the native daemon client and catalogue network are deterministic. All writes use an owned temp tree. */
export async function bundlesManagementServer() {
  const app = Fastify(), root = await mkdtemp(path.join(os.tmpdir(), "bundles-ui-")), bus = new EventBus()
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const file = path.join(global, "opencode.jsonc"), entry = catalogEntry("fixture"), spec = `${entry.package}@${entry.range}`
  const catalogEntries = [entry]
  const state = { current: true, owned: true, runtime: [] as any[], rpc: [] as string[], updates: [] as unknown[], packages: [] as unknown[],
    metadata: {} as Record<string, unknown>, location: project, fail: false, prepares: 0, offset: 0, sessionLists: 0,
    catalogState: "fresh" as "fresh" | "stale" | "unavailable",
    host: { state: "absent", action: "install" } as Record<string, string>, nativeGeneration: 1,
    binding: new Map<string, boolean>(), rpcInputs: [] as Array<{ method: string; input: any }>, uncertain: false, holdTerminal: false,
    offerLabel: "Fixture window", offerDocument: "Scene.blend", conversation: "Work" }
  const streamFrames: string[] = [], requests: Array<{ method: string; body: any }> = [], closes = new Set<() => void>()
  const held = new Set<string>(), waiting = new Map<string, Set<() => void>>(), terminals: Array<() => void> = []
  const release = (key: string) => { held.delete(key); for (const resolve of waiting.get(key) ?? []) resolve(); waiting.delete(key) }
  const connection: any = { assertCurrent() { if (!state.current) throw new Error("PRIVATE_CONNECTION") }, client: {
    config: { get: async () => [{ type: "directory", path: global }, { type: "document", path: file, info: parse(await readFile(file, "utf8")) }] },
    plugin: { list: async () => ({ data: state.runtime }), update: async (input: any) => { state.packages.push(input); state.runtime[0].source.version = "0.2.0" } },
    session: { get: async ({ sessionID }: any) => ({ id: sessionID, title: state.conversation, location: { directory: state.location }, metadata: state.metadata }),
      list: async () => { state.sessionLists++; return { data: [] } },
      update: async (input: any) => { state.updates.push(input); state.metadata = input.metadata } },
    rpc: { call: async ({ method, input }: any) => {
      state.rpc.push(method); state.rpcInputs.push({ method, input })
      if (state.fail) throw new Error("PRIVATE_NATIVE_ERROR")
      if (method === "attachHost") {
        state.binding.set(input.sessionID, true)
        if (state.uncertain) throw new Error("PRIVATE_TRANSPORT_LOST_AFTER_SUBMISSION")
      }
      if (method === "installHost") state.host = { state: "ok", partVersion: "0.1.0" }
      return { output: method === "status" ? { contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
         host: state.host, connection: { state: "available", offers: 1, attachedSessions: 6137 } }
        : method === "hosts" ? { offers: [{ offerID: "offer_fixture", label: state.offerLabel, document: state.offerDocument, protocol: "ok" }] }
        : method === "bindingRead" ? { state: state.binding.get(input.sessionID) ? "attached" : "none",
          authority: { serviceGeneration: "PRIVATE_SERVICE_GENERATION", registryGeneration: "PRIVATE_REGISTRY_GENERATION", revision: 6137 },
          ...(state.binding.get(input.sessionID) ? { binding: { offerID: "offer_fixture", label: state.offerLabel } } : {}) }
        : { outcome: method === "attachHost" ? "attached" : "installed" } }
    } },
  } }
  const manager: any = { get: () => ({}), getSharedServiceConnection: async () => connection,
    ownsLocation: async () => state.owned, getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async () => "owned", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value }
  const catalog = { snapshot: () => ({ state: state.catalogState, catalog: catalogOf(...catalogEntries) }), read: async () => catalog.snapshot() }
  const logger: any = { debug() {}, trace() {}, info() {}, isLevelEnabled: () => false }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} } as any, logger })
  const sources = new PluginSources({ documents: controls, catalog, logger }), packages = new PluginPackages({ controls, workspaceManager: manager })
  const attachments = new IntegrationAttachments({ controls, catalog, workspaceManager: manager, hostPlatform: "win32" })
  const integrations = new IntegrationsReader({ controls, catalog, workspaceManager: manager })
  const actions = new BundlesActions({ workspaceManager: manager, catalog, controls, sources, packages, attachments })
  const store = new PanelExtensionStore(path.join(root, "extensions"))
  const pkg = await readPanelExtensionArchive(fixtureArchive(author, { id: "fixture.bundles", name: "Bundles fixture", apiVersion: 4,
    permissions: ["session.context", "bundles.read", "bundles.manage"] }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const timers = new Map<object, { due: number; callback(): void; native: ReturnType<typeof setTimeout> }>()
  const now = () => Date.now() + state.offset
  const lifecycle = new BundlesLifecycle({ now, setTimeout(callback, delay) {
    const key = {}, native = setTimeout(() => { timers.delete(key); callback() }, delay)
    timers.set(key, { due: now() + delay, callback, native }); return key
  }, clearTimeout(key) { const timer = timers.get(key as object); if (timer) clearTimeout(timer.native); timers.delete(key as object) } })
  const transport = new BundlesTransport({ eventBus: bus, store, workspaceManager: manager, lifecycle, catalog,
    auth: { getSessionFromRequest(req) { return req.headers.cookie?.includes("human=fixture") ? { username: "human", sessionId: "fixture" } : null } },
    actions: { accepts: action => actions.accepts(action), prepare(...args) { state.prepares++; return actions.prepare(...args) } } })
  app.addHook("onRequest", (request, reply, done) => {
    if (request.url.startsWith("/api/events")) {
      const write = reply.raw.write.bind(reply.raw)
      reply.raw.write = ((...args: any[]) => {
        const value = String(args[0]); streamFrames.push(value)
        if (state.holdTerminal && value.startsWith("event: codenomad.bundles.event") && value.includes('"kind":"request"')) {
          terminals.push(() => { if (!reply.raw.destroyed && !reply.raw.writableEnded) (write as any)(...args) }); return true
        }
        return (write as any)(...args)
      }) as any
    }
    done()
  })
  app.addHook("preHandler", async request => {
    if (/\/bundles\//.test(request.url)) requests.push({ method: request.url.split("/").at(-1)!, body: request.body })
    const key = request.url.split("/").at(-1)!
    if (held.has(key)) await new Promise<void>(resolve => { const set = waiting.get(key) ?? new Set(); set.add(resolve); waiting.set(key, set) })
  })
  registerEventRoutes(app, { eventBus: bus, bundlesTransport: transport, logger,
    registerClient(close) { closes.add(close); return () => closes.delete(close) },
    connectionManager: { register() { return () => {} }, pong: () => true } as any })
  registerPanelExtensionRoutes(app, { store, workspaceManager: manager })
  registerPanelExtensionBundlesManagementRoutes(app, { transport })
  registerPanelExtensionBundlesRoutes(app, { store, workspaceManager: manager, catalog, integrations, attachments, budget: lifecycle.budget })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
   return { app, address, state, requests, streamFrames, file, spec, entry, catalogEntries, controls, sources, project,
    hold: (key: string) => held.add(key), release,
    flushTerminals() { state.holdTerminal = false; for (const write of terminals.splice(0)) write() },
    async reset(installed = true, readOnly = false, panelHtml = author) {
      for (const key of held) release(key)
      terminals.length = 0; state.holdTerminal = false; state.uncertain = false
      state.current = true; state.owned = true; state.location = project; state.fail = false; state.offset += 301_000
      state.host = { state: "absent", action: "install" }
      entry.range = "^0.1"
      entry.docs = catalogEntry("fixture").docs; state.catalogState = "fresh"
      catalogEntries.splice(0, catalogEntries.length, entry)
      entry.displayName = "OpenCode for fixture"
      state.offerLabel = "Fixture window"; state.offerDocument = "Scene.blend"; state.conversation = "Work"
      state.rpc = []; state.rpcInputs = []; state.updates = []; state.packages = []; state.prepares = 0; state.sessionLists = 0
      state.metadata = { foreign: "FOREIGN_SESSION_7ce0" }; state.binding = new Map([["ses_FOREIGN_SESSION_7ce0", true]])
      state.runtime = installed ? [{ id: entry.plugin, source: { type: "package", target: spec, version: "0.1.0" }, features: {}, state: { status: "active" },
        privateToken: "FOREIGN_TOKEN_96aa" }] : []
      await writeFile(file, JSON.stringify({ plugins: installed ? [spec] : [] }) + "\n")
      const installedPackage = (await store.list()).find(candidate => candidate.manifest.id === pkg.manifest.id)
      const target = readOnly || panelHtml !== author ? await readPanelExtensionArchive(fixtureArchive(panelHtml, { id: pkg.manifest.id, name: "Bundles fixture", apiVersion: 4,
        permissions: ["session.context", "bundles.read", ...(!readOnly ? ["bundles.manage"] : [])] })) : pkg
      if (installedPackage?.digest !== target.digest) await store.install(target, installedPackage?.digest)
      await store.activate(target.manifest.id, target.digest, true); requests.length = 0; streamFrames.length = 0
      bus.publish({ type: "instance.eventStatus", instanceId: "api4-instance", status: "connected", generation: state.nativeGeneration } as any)
    },
    revoke: () => store.activate(pkg.manifest.id, pkg.digest, false),
    uninstall: () => store.remove(pkg.manifest.id, pkg.digest),
    async replace() { await store.install(await readPanelExtensionArchive(fixtureArchive(author + "<!-- replacement -->", {
      id: pkg.manifest.id, name: "Bundles fixture", version: "1.0.1", apiVersion: 4,
      permissions: ["session.context", "bundles.read", "bundles.manage"],
    })), pkg.digest) },
    disconnect: () => { for (const close of closes) close() },
    observeRuntime(runtime: typeof state.runtime) {
      state.runtime = runtime
      bus.publish({ type: "instance.event", instanceId: "api4-instance", event: { type: "plugin.updated", data: { location: { directory: project } } } } as any)
    },
    nativeDisconnect() { state.current = false; bus.publish({ type: "instance.eventStatus", instanceId: "api4-instance", status: "disconnected", generation: state.nativeGeneration } as any) },
    nativeReconnect() { state.current = true; bus.publish({ type: "instance.eventStatus", instanceId: "api4-instance", status: "connected", generation: ++state.nativeGeneration } as any) },
    advance(ms: number) { state.offset += ms; for (const [key, timer] of timers) if (timer.due <= now()) { clearTimeout(timer.native); timers.delete(key); timer.callback() } },
    async close() { for (const key of held) release(key); for (const close of closes) close(); terminals.length = 0; transport.dispose(); for (const timer of timers.values()) clearTimeout(timer.native); await app.close(); await rm(root, { recursive: true, force: true }) },
  }
}
