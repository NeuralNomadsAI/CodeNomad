import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import { createServerApi } from "./api-client"
import { createBackendTransport } from "./backend-transport"
import { backendEvents } from "./server-events"
import { createInstanceFetch } from "./sdk-manager"
import { backgroundReads } from "./background-read-queue"
import { createProviderUsageState } from "../components/session/provider-usage-state"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
const source = () => ({ on: () => () => {}, onOpen: () => () => {}, onTransportStatus: () => () => {}, onDispose: () => () => {} })

test("view HTTP methods forward optional cancellation without changing their routes or bodies", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const api = createServerApi({ ...createBackendTransport({ id: "view-io", baseUrl: "https://example.test" }),
    fetch: async (input, init) => { seen.push({ url: String(input), init }); return Response.json({}) },
  })
  const controller = new AbortController(), signal = controller.signal
  const settings = { location: { directory: "/repo" }, mediaStorage: true }
  await api.getImageSettings("i", "/repo", signal)
  await api.setImageSettings("i", settings, signal)
  await api.getWebSearchSettings("i", "/repo", signal)
  await api.setWebSearchSettings("i", { location: { directory: "/repo" }, scope: "global", provider: null }, signal)
  await api.getProviderAccounts("i", "provider", "/repo", signal)
  await api.setProviderAccountSelection("i", "provider", "/repo", true, signal)
  await api.fetchProviderUsage("i", "s", "provider", "model", signal)
  await api.writeWorkspaceFile("i", "file.txt", "draft", { directory: "/repo", signal })
  await api.stageWorktreeGitPaths("i", "root", { paths: ["file.txt"] }, signal)
  await api.unstageWorktreeGitPaths("i", "root", { paths: ["file.txt"] }, signal)
  await api.initializeWorkspaceGit("i", "/repo", signal)
  await api.commitWorktreeGitChanges("i", "root", { message: "commit" }, signal)
  assert.equal(seen.length, 12)
  assert.ok(seen.every(request => request.init?.signal === signal))
  assert.deepEqual(seen.map(request => new URL(request.url).pathname), [
    "/api/workspaces/i/image-settings", "/api/workspaces/i/image-settings",
    "/api/workspaces/i/websearch-settings", "/api/workspaces/i/websearch-settings",
    "/api/workspaces/i/provider-accounts/provider", "/api/workspaces/i/provider-accounts/provider", "/api/usage/provider",
    "/api/workspaces/i/files/content", "/api/workspaces/i/worktrees/root/git-stage", "/api/workspaces/i/worktrees/root/git-unstage",
    "/api/workspaces/i/git-init", "/api/workspaces/i/worktrees/root/git-commit",
  ])
  assert.deepEqual(JSON.parse(String(seen[7].init?.body)), { contents: "draft" })
  assert.ok(seen.every(request => !request.url.includes("signal") && !String(request.init?.body).includes("signal")))
})

test("view HTTP adapters reject late data and do not dispatch an already cancelled write", async () => {
  const response = deferred<Response>(), controller = new AbortController()
  let calls = 0
  const api = createServerApi({ ...createBackendTransport({ id: "late-io", baseUrl: "https://example.test" }),
    fetch: async () => { calls++; return response.promise },
  })
  const reading = api.getImageSettings("i", "/repo", controller.signal)
  const rejected = assert.rejects(reading, { name: "AbortError" })
  controller.abort(); response.resolve(Response.json({ old: true })); await rejected
  await assert.rejects(api.writeWorkspaceFile("i", "f", "draft", { directory: "/repo", signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls, 1)
})

test("SDK captures the attachment when invoked, fences late 426 responses, and reacquires on the next call", async () => {
  const base = "https://example.test/workspaces/i/instance/", response = deferred<Response>()
  const signals: AbortSignal[] = []
  let calls = 0
  const fetcher = createInstanceFetch(base, () => true, async (_input, init) => {
    signals.push(init!.signal!); calls++
    return calls === 1 ? response.promise : Response.json({ current: true })
  }, "sdk-view-io~i")
  let detach = backendEvents.attach("sdk-view-io", source())
  try {
    const pending = fetcher(`${base}api/session/s`)
    const rejected = assert.rejects(pending, { name: "AbortError" })
    detach(); detach = backendEvents.attach("sdk-view-io", source())
    response.resolve(new Response(null, { status: 426 })); await rejected
    assert.equal(signals[0].aborted, true)
    assert.deepEqual(await (await fetcher(`${base}api/session/s`)).json(), { current: true })
    assert.equal(signals[1].aborted, false)
  } finally { detach() }
})

test("SDK combines Request/init cancellation and removes revoked catalogue reads before queue dispatch", async () => {
  const base = "https://example.test/workspaces/i/instance/", occupied = deferred<void>()
  const blockers = [0, 1].map(() => backgroundReads.run(new AbortController().signal, () => occupied.promise))
  await Promise.resolve()
  const detach = backendEvents.attach("sdk-queued-io", source())
  let calls = 0
  const fetcher = createInstanceFetch(base, () => false, async () => { calls++; return Response.json({}) }, "sdk-queued-io~i")
  try {
    const pending = fetcher(`${base}api/model`)
    const rejected = assert.rejects(pending, { name: "AbortError" })
    detach(); occupied.resolve(); await rejected; await Promise.all(blockers)
    assert.equal(calls, 0)
    const request = new AbortController(), init = new AbortController()
    const standalone = createInstanceFetch(base, () => true, async (_input, options) => {
      assert.equal(options!.signal!.aborted, false)
      request.abort()
      assert.equal(options!.signal!.aborted, true)
      return Response.json({})
    })
    await assert.rejects(standalone(new Request(`${base}api/session/s`, { signal: request.signal }), { signal: init.signal }), { name: "AbortError" })
  } finally { detach(); occupied.resolve(); await Promise.all(blockers) }
})

test("SDK rechecks attachment after importing setup before publishing a 426", async () => {
  const entered = deferred<void>(), gate = deferred<void>()
  const fixture = { entered, gate, reports: 0 }
  ;(globalThis as any).__sdkSetupImportGate = fixture
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.includes("stores/opencode-setup") && context.parentURL?.includes("sdk-manager")) {
      const code = `const f = globalThis.__sdkSetupImportGate; f.entered.resolve(); await f.gate.promise;
        export const reportOpenCodeSetupRequired = () => { f.reports++ };`
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(code)}` }
    }
    return nextResolve(specifier, context)
  } })
  const detach = backendEvents.attach("sdk-import-io", source())
  try {
    const base = "https://example.test/workspaces/i/instance/"
    const fetcher = createInstanceFetch(base, () => true, async () => new Response(null, { status: 426 }), "sdk-import-io~i")
    const pending = fetcher(`${base}api/session/s`)
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await entered.promise
    detach(); gate.resolve(); await rejected
    assert.equal(fixture.reports, 0)
  } finally { detach(); gate.resolve(); hooks.deregister(); delete (globalThis as any).__sdkSetupImportGate }
})

test("quota invalidation aborts the admitted HTTP signal before another account can refresh", async () => {
  const gate = deferred<any>(), signals: AbortSignal[] = [], published: unknown[] = []
  const state = createProviderUsageState((_source, signal) => { signals.push(signal!); return gate.promise }, value => published.push(value))
  state.select({ instanceId: "i", sessionId: "s", directory: "/repo", providerId: "provider", modelId: "model" })
  const reading = state.refresh()
  assert.equal(signals[0].aborted, false)
  state.invalidate(); assert.equal(signals[0].aborted, true)
  gate.resolve({ stale: true }); await reading
  assert.deepEqual(published, [undefined, undefined])
  state.dispose()
})
