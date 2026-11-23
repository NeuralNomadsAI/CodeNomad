import assert from "node:assert/strict"
import { test } from "node:test"
import { productionModule } from "../../tests/test-support/production-ast"
import { deferred } from "../../tests/test-support/deferred"
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack } from "solid-js"
import { z } from "zod"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { BackgroundReadQueue } from "../lib/background-read-queue"
import { integrationAttachChoice, integrationLink } from "../lib/integration-row-state"

// Execute the real view functions, with imports supplied explicitly. No JSX or
// application singleton is needed to test their asynchronous authority boundary.
function view(path: string, imports: Record<string, unknown>) {
  return productionModule(new URL(path, import.meta.url), { backendOf: () => ({ api: imports.serverApi }), ...imports })
}
const solid = { createEffect, createMemo, createSignal, on, onCleanup, untrack }
const fileDraftImports = { sha256, bytesToHex, instances: () => new Map(), localServerMeta: { meta: () => undefined } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function attachment() {
  let controller = new AbortController()
  const [signal, setSignal] = createSignal(controller.signal)
  return {
    capture: (_id: string, parent?: AbortSignal, owns = () => true) => {
      const captured = parent ? AbortSignal.any([signal(), parent]) : signal()
      return { signal: captured, current: () => !captured.aborted && owns() }
    },
    revoke: () => controller.abort(),
    replace: () => { controller.abort(); controller = new AbortController(); setSignal(controller.signal) },
  }
}
const events = { on: () => () => {}, forInstance: () => ({ onOpen: () => () => {} }) }

test("files: revocation during the conflict read cannot prepare a write or lose the draft", async () => {
  const backend = attachment(), disk = deferred<{ contents: string }>()
  let writes = 0, signal!: AbortSignal, close!: () => void
  const { useWorkspaceFileEditor } = view("./workspace-file-editor.ts", {
    ...solid, ...fileDraftImports, serverApi: {
      previewWorkspaceFile: (_id: string, _path: string, _directory: string, requestSignal: AbortSignal) => { signal = requestSignal; return disk.promise },
      writeWorkspaceFile: async () => { writes++ },
    }, showConfirmDialog: async () => true, showToastNotification: () => {}, invalidateFilesystemCaches: () => {},
  })
  const target = { directory: "/repo", path: "a.txt" }
  const options = { instanceId: "i", target: () => target, active: () => true, t: (key: string) => key, onError: () => {}, captureOperation: backend.capture }
  const editor = createRoot(dispose => { close = dispose; return useWorkspaceFileEditor(options) })
  editor.adopt("baseline"); editor.change("my draft")
  const saving = editor.save()
  backend.revoke(); backend.replace()
  assert.equal(signal.aborted, true)
  disk.resolve({ contents: "baseline" }); await saving
  assert.equal(writes, 0)
  assert.equal(editor.text(), "my draft")
  assert.equal(editor.dirty(), true)
  assert.equal(editor.saving(), false)
  close()
  const reopened = createRoot(dispose => { close = dispose; return useWorkspaceFileEditor(options) })
  assert.equal(reopened.reset(), "my draft")
  close()
})

test("files: revocation during confirmation prevents the later write", async () => {
  const backend = attachment(), consent = deferred<boolean>()
  let writes = 0, close!: () => void
  const { useWorkspaceFileEditor } = view("./workspace-file-editor.ts", {
    ...solid, ...fileDraftImports, serverApi: { previewWorkspaceFile: async () => ({ contents: "changed on disk" }), writeWorkspaceFile: async () => { writes++ } },
    showConfirmDialog: () => consent.promise, showToastNotification: () => {}, invalidateFilesystemCaches: () => {},
  })
  const target = { directory: "/repo", path: "confirm.txt" }
  const editor = createRoot(dispose => { close = dispose; return useWorkspaceFileEditor({ instanceId: "i", target: () => target,
    active: () => true, t: (key: string) => key, onError: () => {}, captureOperation: backend.capture }) })
  editor.adopt("baseline"); editor.change("my draft")
  const saving = editor.save(); await flush()
  backend.revoke(); consent.resolve(true); await saving
  assert.equal(writes, 0); assert.equal(editor.text(), "my draft")
  close()
})

test("providers: a retained settings view reacquires, and the old read cannot publish", async () => {
  const backend = attachment(), reads: ReturnType<typeof deferred<any>>[] = []
  let close!: () => void, writes = 0
  const { useImageSettings } = view("./settings/useImageSettings.ts", { ...solid,
    captureBackendOperation: backend.capture, serverEvents: events, getActiveCatalogLocation: () => ({ directory: "/repo" }),
    serverApi: { getImageSettings: () => { const read = deferred<any>(); reads.push(read); return read.promise }, setImageSettings: async () => { writes++ } },
  })
  const settings = createRoot(dispose => { close = dispose; return useImageSettings({ instanceId: "i" }) })
  assert.equal(reads.length, 1)
  backend.replace()
  assert.equal(reads.length, 2)
  reads[1].resolve({ generation: "new" }); await flush()
  reads[0].resolve({ generation: "old" }); await flush()
  assert.equal(settings.snapshot().generation, "new")
  backend.revoke(); await settings.save({ mediaStorage: true })
  assert.equal(writes, 0)
  close()
})

test("providers: detached web search completion cannot start its trailing reload", async () => {
  const backend = attachment(), write = deferred<void>()
  let reads = 0, close!: () => void
  const client = { websearch: { providers: async () => ({ data: [] }) }, integration: { list: async () => ({ data: [] }) } }
  const { useWebSearchSettings } = view("./settings/useWebSearchSettings.ts", { ...solid,
    captureBackendOperation: backend.capture, serverEvents: events, getRootClient: () => client,
    getActiveCatalogLocation: () => ({ directory: "/repo" }), toRequestLocation: (value: unknown) => value, requestLocationOptions: () => ({}),
    serverApi: { getWebSearchSettings: async () => { reads++; return {} }, setWebSearchSettings: () => write.promise },
  })
  const settings = createRoot(dispose => { close = dispose; return useWebSearchSettings({ instanceId: "i" }) })
  await flush()
  const saving = settings.save("project", "provider")
  backend.revoke(); write.resolve(); assert.equal(await saving, false)
  assert.equal(reads, 1)
  close()
})

test("integrations: old consent cannot admit an installation on a new attachment", async () => {
  const backend = attachment(), consent = deferred<boolean>()
  let installs = 0, refreshes = 0, close!: () => void
  const { createIntegrationHostInstallation } = view("./integration-host-installation.ts", { ...solid,
    captureBackendOperation: backend.capture, useI18n: () => ({ t: (key: string) => key }),
    integrationEpoch: () => "epoch", integrations: { refreshDemanded: () => { refreshes++ } },
    confirmIntegrationAction: () => consent.promise, integrationAttachmentRequest: async () => { installs++; return { outcome: "installed" } },
    showToastNotification: () => {}, HttpResponseError: Error, document: { activeElement: null }, HTMLElement: class {},
  })
  const installation = createRoot(dispose => { close = dispose; return createIntegrationHostInstallation({ instanceId: "i", directory: "/repo", entries: () => [
    { id: "integration", family: "native", state: "ok", app: { name: "App" }, status: { version: "1", host: { state: "available", action: "install" } } },
  ] }) })
  const pending = installation.open("integration")
  backend.replace(); consent.resolve(true); await pending
  assert.equal(installs, 0); assert.equal(refreshes, 0)
  close()
})

test("integrations: reinstall stays confirmed for open and closed applications", async () => {
  const backend = attachment(), titles: string[] = []
  let installs = 0, close!: () => void
  const [host, setHost] = createSignal({ state: "available" })
  const { createIntegrationHostInstallation } = view("./integration-host-installation.ts", { ...solid,
    captureBackendOperation: backend.capture, useI18n: () => ({ t: (key: string) => key }),
    integrationEpoch: () => "epoch", integrations: { refreshDemanded: () => {} },
    confirmIntegrationAction: async (_warning: string, options: { title: string }) => { titles.push(options.title); return true },
    integrationAttachmentRequest: async () => { installs++; return { outcome: "unchanged" } },
    showToastNotification: () => {}, HttpResponseError: Error, document: { activeElement: null }, HTMLElement: class {},
  })
  const installation = createRoot(dispose => { close = dispose; return createIntegrationHostInstallation({
    instanceId: "i", directory: "/repo", entries: () => [
      { id: "integration", family: "native", state: "ok", app: { name: "App" }, status: { version: "1", host: host() } },
    ],
  }) })
  for (const state of ["available", "unknown"]) {
    setHost({ state })
    assert.equal(installation.action("integration"), "reinstall")
    await installation.open("integration")
  }
  setHost({ state: "unsupported" })
  assert.equal(installation.action("integration"), undefined)
  await installation.open("integration")
  assert.deepEqual(titles, ["integrations.installHost.reinstall", "integrations.installHost.reinstall"])
  assert.equal(installs, 2)
  close()
})

test("integrations: state-line document reads reacquire and fence late backend replies", async () => {
  const backend = attachment(), reads: ReturnType<typeof deferred<any>>[] = []
  let close!: () => void
  const { createIntegrationRowBinding } = view("./integration-row-binding.ts", { ...solid,
    captureBackendOperation: backend.capture,
    backendEvents: { signalForInstance: () => backend.capture("i").signal },
    integrationEpoch: () => "epoch", integrationLink, integrationAttachChoice,
    integrationBindings: { demand: () => () => {}, state: () => ({ state: "none" }), busy: () => false },
    useI18n: () => ({ t: (key: string) => key }), showToastNotification: () => {},
    integrationAttachmentRequest: () => { const read = deferred<any>(); reads.push(read); return read.promise },
  })
  const row = createRoot(dispose => { close = dispose; return createIntegrationRowBinding({
    instanceId: () => "i", directory: () => "/repo", sessionId: () => "ses_1", active: () => true,
    integration: () => ({ id: "integration", family: "native", state: "ok", status: { host: { state: "available" }, connection: { offers: 1 } } }),
  }) })
  assert.equal(reads.length, 1)
  backend.replace()
  assert.equal(reads.length, 2)
  const current = [{ offerID: "new", protocol: "ok", label: "Current" }]
  reads[1].resolve({ offers: current }); await flush()
  assert.deepEqual(row.offers(), current)
  reads[0].resolve({ offers: [{ offerID: "old", protocol: "ok", label: "Old" }] }); await flush()
  assert.deepEqual(row.offers(), current)
  backend.replace()
  assert.equal(row.offers(), undefined)
  assert.equal(reads.length, 3)
  close()
  reads[2].resolve({ offers: current }); await flush()
  assert.equal(row.offers(), undefined)
})

test("providers: an old quota response cannot publish or perform its coalesced follow-up", async () => {
  const backend = attachment(), response = deferred<any>(), published: unknown[] = []
  let reads = 0
  const { createProviderUsageState } = view("./session/provider-usage-state.ts", {})
  const state = createProviderUsageState(() => { reads++; return response.promise }, (value: unknown) => published.push(value), () => backend.capture("i"))
  state.select({ instanceId: "i", sessionId: "s", directory: "/repo", providerId: "p", modelId: "m" })
  const pending = state.refresh(); state.refresh()
  backend.revoke(); response.resolve({ account: "old" }); await pending
  assert.deepEqual(published, [undefined]); assert.equal(reads, 1)
  state.dispose()
})

test("files: a queued directory read cannot dispatch with revoked authority", async () => {
  const backend = attachment(), queue = new BackgroundReadQueue(1), occupied = deferred<void>()
  const busy = queue.run(new AbortController().signal, () => occupied.promise)
  await flush()
  let reads = 0, close!: () => void
  const { useWorkspaceTree } = view("./instance/shell/right-panel/useWorkspaceTree.ts", { ...solid,
    backgroundReads: queue, serverApi: { listWorkspaceFiles: async () => { reads++; return [] } },
    filesystemInvalidationVersion: () => 0, createDebouncedRefresh: (run: () => void) => ({ trigger: run, cancel: () => {} }),
  })
  const tree = createRoot(dispose => { close = dispose; return useWorkspaceTree("i", () => "/repo", () => true, backend.capture) })
  backend.revoke(); occupied.resolve(); await busy; await flush()
  assert.equal(reads, 0); assert.equal(tree.rows().length, 0)
  close()
})

test("extensions: a late forge address cannot open a browser or answer a replacement attachment", async () => {
  const backend = attachment(), address = deferred<{ url: string }>(), answers: unknown[] = []
  let opened = 0, close!: () => void
  const { useWorkItemsChannel } = view("./panel-extensions/work-items-channel.ts", { ...solid, z,
    serverEvents: { forInstance: () => ({ onTransportStatus: () => () => {} }) },
    panelExtensionsApi: { workItemUrl: () => address.promise }, openExternalUrl: async () => { opened++; return true },
  })
  const receive = createRoot(dispose => { close = dispose; return useWorkItemsChannel({ instanceId: "i", id: "extension", digest: "d",
    send: (value: unknown) => answers.push(value), captureOperation: backend.capture }) })
  const pending = receive({ type: "workItems:request", id: 1, method: "open", input: { kind: "issue", number: 1 } })
  backend.replace(); address.resolve({ url: "https://example.com/issue/1" }); await pending
  assert.equal(opened, 0); assert.deepEqual(answers, [])
  close()
})

test("sessions: hydration from the old attachment cannot start a message read", async () => {
  const backend = attachment(), hydration: ReturnType<typeof deferred<void>>[] = [], reads: AbortSignal[] = []
  const forces: boolean[] = []
  let close!: () => void
  const { useActiveSessionMessageLoad } = view("../lib/hooks/use-active-session-message-load.ts", solid)
  createRoot(dispose => {
    close = dispose
    useActiveSessionMessageLoad({ isActive: () => true, instanceId: () => "i", session: () => ({ id: "s" }),
      forceLoad: true,
      captureOperation: backend.capture, waitForHydration: () => { const gate = deferred<void>(); hydration.push(gate); return gate.promise },
      loadMessages: (_id: string, _session: string, options: { signal: AbortSignal; force: boolean }) => { reads.push(options.signal); forces.push(options.force) },
    })
  })
  backend.replace()
  assert.equal(hydration.length, 2)
  hydration[0].resolve(); await flush()
  assert.equal(reads.length, 0)
  hydration[1].resolve(); await flush()
  assert.equal(reads.length, 1); assert.equal(reads[0].aborted, false)
  assert.deepEqual(forces, [true])
  close()
})
