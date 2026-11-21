// Mode `automation`: each server's automation bridge with a scripted desktop host on its native
// channel. Registration, token and body refusals, session ownership (root, subfolder, foreign,
// missing), Missions not-owner answers, browser claim/probe/execute forwarding with the exact
// native requests, the window status checks and command validation, then the TS plugin's own
// browser client. Window inspection and actions run in the desktop host under Rust (the reference drives
// a CDP port): their forwarding is asserted on the Rust side only.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fromDist } from "./fixtures.mjs"
import { bridgeClient, loopbackFetch } from "./memory.mjs"

export const comparable = value => value.compared

/** Rust only: the window commands the bridge forwards to the host (`developer.execute`), the run and
 * window an inspection pins, refusals by stage, restart and the server's own diagnostics. */
async function window(native, post, sessions, ready, answer) {
  const ok = result => ({ ok: true, result })
  const { runId, nativeIdentity, windowId, windowInstance } = ready
  const exact = { runId, windowId, windowInstance }
  const target = `${nativeIdentity}/${runId}/${windowId}/${windowInstance}`
  const document = "fixture-document"
  const context = { windowId, windowInstance, instanceId: "local", sessionId: sessions.root, tabId: "tab-a", sessionOpen: true }
  const inspection = { target: { id: "local-window-1", title: "CodeNomad", url: "http://127.0.0.1/" },
    context, document, snapshot: "- button \"Save\" [e1]", collapsed: 0, diagnostics: [{ level: "log", text: "renderer" }] }
  const other = { ...ready, windowId: "window-2", windowInstance: "instance-2" }
  const others = [other, { ...other, windowId: "window-3" }, { ...other, windowId: "window-4" }]
  const host = (execute, selected = ready) => answer({
    "developer.targets": () => ok({ status: selected, windows: [ready, ...others].map(w => ({
      windowId: w.windowId, windowInstance: w.windowInstance, focused: w === selected,
    })) }),
    "developer.status": params => {
      const status = !params.windowId ? selected : [ready, ...others].find(w => w.windowId === params.windowId) ?? { state: "starting" }
      return ok({ status, logs: [{ level: "error", text: "preview failure" }] })
    },
    "developer.execute": params => {
      const { command, windowId: id } = params
      if (command.action !== "context") return ok(execute(params))
      if (id === windowId) return ok({ context, document })
      if (id === "window-4") return ok({ error: "Window closed", stage: "target" })
      return ok({ context: { ...context, windowId: id, windowInstance: other.windowInstance,
        instanceId: "remote~project", sessionOpen: id === "window-2" }, document })
    },
    "developer.restart": () => ok({ state: "starting", runId, nativeIdentity }),
  })
  const call = (command, extra) => post({ mode: "developer-execute", sessionID: sessions.root, command, ...extra })
  const probe = extra => post({ mode: "developer-probe", sessionID: sessions.root, ...extra })
  const reset = () => { native.requests.length = 0 }
  const executed = () => native.requests.filter(r => r.method === "developer.execute").map(r => r.params)
  host(() => inspection)
  assert.deepEqual(await probe(), { status: 200, body: { result: { available: true, nativeIdentity, ...exact } } })
  assert.deepEqual(executed(), [{ ...exact, sessionID: sessions.root, command: { action: "context" } }])
  reset()
  const inventory = await probe({ purpose: "targets" })
  assert.deepEqual(inventory.body.result.windows.map(w => [w.windowId, w.session, w.tabId]),
    [[windowId, "visible", "tab-a"], ["window-2", "open", undefined], ["window-3", "elsewhere", undefined], ["window-4", "unknown", undefined]])
  assert.equal(executed().length, 4)
  reset()
  assert.equal((await probe({ purpose: "target", target })).status, 200)
  assert.deepEqual(native.requests, [{ method: "developer.status", params: exact }], "an explicit probe does not touch the renderer")
  reset()
  const act = await call({ action: "click", ref: "e1" })
  assert.deepEqual([act.status, act.body.code, native.requests.length], [404, "inspect-required", 0])
  const source = "00000000-0000-0000-0000-000000000000"
  const inspected = await call({ action: "inspect", query: "Save" }, { target, order: `${source}/2` })
  assert.equal(inspected.status, 200)
  assert.deepEqual(native.requests, [
    { method: "developer.status", params: exact },
    { method: "developer.execute", params: { ...exact, sessionID: sessions.root, command: { action: "inspect", query: "Save" } } },
    { method: "developer.status", params: exact },
  ])
  assert.deepEqual(inspected.body.result.diagnostics.slice(0, 2), [{ level: "log", text: "renderer" }, { level: "error", text: "preview failure" }])
  const { pin } = inspected.body.result
  assert.match(pin, /^[\da-f-]{36}$/)
  assert.equal(inspected.body.result.document, undefined, "document is private to the bridge")
  assert.equal(inspected.body.result.context.sessionOpen, undefined)
  reset()
  assert.equal((await call({ action: "inspect" }, { target, order: `${source}/1` })).body.code, "stale-inspection")
  assert.equal((await call({ action: "click", ref: "e1" }, { sessionID: sessions.subfolder, pin })).body.code, "target-gone")
  assert.deepEqual(native.requests, [])
  host(() => inspection, other)
  const expanded = await call({ action: "inspect", ref: "e1" }, { pin })
  assert.equal(expanded.status, 200)
  assert.equal(expanded.body.result.pin, undefined)
  assert.deepEqual(executed(), [{ ...exact, document, sessionID: sessions.root, command: { action: "inspect", ref: "e1" } }])
  reset()
  host(() => inspection, other)
  const refreshed = await call({ action: "inspect" }, { pin, order: `${source}/3` })
  assert.equal(refreshed.status, 200)
  assert.deepEqual(executed(), [{ ...exact, sessionID: sessions.root, command: { action: "inspect" } }])
  reset()
  host(({ command }) => ({ ok: true, value: command.text }))
  const typed = await call({ action: "type", ref: "e1", text: "abc" }, { pin })
  assert.deepEqual([typed.status, typed.body.result, executed()[0]], [200, { ok: true, value: "abc" },
    { ...exact, document, sessionID: sessions.root, command: { action: "type", ref: "e1", text: "abc", clear: true } }])
  host(() => ({ error: "e1 is covered by div \"Overlay\"; close or move it first, then inspect again", stage: "action" }))
  const covered = await call({ action: "click", ref: "e1" }, { pin })
  assert.deepEqual([covered.status, covered.body.error], [409, "e1 is covered by div \"Overlay\"; close or move it first, then inspect again"])
  host(() => ({ error: "Page changed; inspect again", stage: "document" }))
  const stale = await call({ action: "press", key: "Enter" }, { pin })
  assert.deepEqual([stale.status, stale.body.code], [409, "stale-document"])
  host(() => ({ image: { data: "iVBORw0KGgo=", mime: "image/png" } }))
  assert.deepEqual((await call({ action: "screenshot" }, { pin })).body.result, { image: { data: "iVBORw0KGgo=", mime: "image/png" } })
  answer({ "developer.status": () => ok({ status: { ...ready, windowInstance: "replacement" } }) })
  reset()
  const moved = await call({ action: "hover", ref: "e1" }, { pin })
  assert.deepEqual([moved.status, moved.body.code, executed().length], [404, "target-gone", 0], "a reopened window cannot inherit the pin")
  let captured = false
  answer({
    "developer.status": () => ok({ status: captured ? { ...ready, windowInstance: "replacement" } : ready }),
    "developer.execute": () => { captured = true; return ok(inspection) },
  })
  const replaced = await call({ action: "inspect" }, { target })
  assert.deepEqual([replaced.status, replaced.body.code, replaced.body.result], [404, "target-gone", undefined],
    "a window replaced during capture cannot publish a receipt")
  host(() => ({ error: "CodeNomad window or active session changed; inspect again", stage: "target" }))
  assert.equal((await call({ action: "press", key: "Enter" }, { pin })).body.code, "target-gone")
  host(() => inspection)
  reset()
  const restarted = await call({ action: "restart" }, { pin })
  assert.deepEqual([restarted.status, restarted.body.result, native.requests],
    [200, { state: "starting", runId, nativeIdentity }, [
      { method: "developer.status", params: exact },
      { method: "developer.execute", params: { ...exact, sessionID: sessions.root, command: { action: "context" } } },
      { method: "developer.restart", params: exact },
    ]])
  assert.equal((await call({ action: "click", ref: "e1" }, { pin })).body.code, "target-gone", "restart forgets all existing receipts for the run")
  assert.equal((await call({ action: "inspect" }, { target })).status, 409, "an acknowledged restart retires the previous run")
}

export async function run({ call, fixture, root, pid, native, folder, data }) {
  assert(native, "the automation mode runs each server under a scripted native host")
  const { registration, file, registry, post, bridge } = await bridgeClient(fixture, pid, 30000)
  const json = (method, body) => ({ method, signal: AbortSignal.timeout(30000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const opened = await call("/api/workspaces", json("POST", { path: folder }))
  assert.equal(opened.status, 201, await opened.clone().text())
  const workspace = await opened.json()
  const sessions = {}
  const created = await call(`${workspace.proxyPath}/api/session`, json("POST", { title: "automation root" }))
  assert.equal(created.status, 200)
  sessions.root = (await created.json()).data.id
  const subfolder = path.join(root, folder, "automation-sub"), outside = path.join(root, "Automation Outside")
  for (const dir of [subfolder, outside]) await mkdir(dir, { recursive: true })
  sessions.subfolder = (await fixture.client.session.create({ location: { directory: subfolder }, title: "automation sub" })).id
  sessions.foreign = (await fixture.client.session.create({ location: { directory: outside }, title: "automation foreign" })).id
  sessions.missing = "ses_missing_automation"
  const names = new Map(Object.entries(sessions).map(([name, id]) => [id, name]))
  const scrub = value => JSON.parse(JSON.stringify(value ?? null).replace(/ses_[A-Za-z0-9]+/g, id => `<session:${names.get(id) ?? "?"}>`))

  const steps = []
  // `statusOnly`: only the status compares; `reply`: the reply without the native requests, which`n  // differ where the reference runs the preview engine itself and the host runs it under Rust.
  const step = async (name, request, { statusOnly = false, reply: only = false } = {}) => {
    native.requests.length = 0
    const reply = await request()
    steps.push(statusOnly ? { name, status: reply.status } : { name, ...scrub(reply), ...(only ? {} : { native: scrub(native.requests) }) })
    return reply
  }
  const answer = replies => { native.answer = (method, params) => replies[method]?.(params) ?? { ok: false, error: { message: `No fixture answer for ${method}` } } }
  const fail = message => () => ({ ok: false, error: { code: "fixture", message } })
  const ok = result => () => ({ ok: true, result })
  const ready = { state: "ready", runId: "run-1", nativeIdentity: "tauri:fixture", cdpUrl: "http://127.0.0.1:9", windowId: "window-1", windowInstance: "instance-1" }
  try {
    // Registration: shape, name and owner-only atomic write leave nothing else behind.
    const expected = new RegExp(`^${registration.startedAt}-${pid}-${registration.token.slice(0, 12)}\\.json$`)
    steps.push({ name: "registration", keys: Object.keys(registration).sort(), version: registration.version,
      url: registration.url.replace(/:\d+\//, ":<port>/"), token: /^[A-Za-z0-9_-]{43}$/.test(registration.token),
      file: expected.test(file.name), newline: file.text.endsWith("}\n"), registry: path.basename(registry) })

    const headers = token => ({ "content-type": "application/json", ...(token ? { "x-codenomad-automation-token": token } : {}) })
    const body = { mode: "developer-probe", sessionID: sessions.root }
    await step("wrong token", () => post(body, headers("x".repeat(43))))
    await step("no token", () => post(body, headers()))
    await step("text/plain", () => post("x", { ...headers(registration.token), "content-type": "text/plain" }))
    await step("no content type", () => post("x", { "x-codenomad-automation-token": registration.token }))
    await step("bad json", () => post("{", headers(registration.token)))
    await step("empty json", () => post("", headers(registration.token)))
    // Fastify may close the socket after its 413 before the body is read: a refusal either way.
    await step("too large", () => post({ ...body, pad: "x".repeat(513 * 1024) })
      .then(r => ({ status: r.status === 413 ? "refused" : r.status }), e => ({ status: e.code === "ECONNRESET" ? "refused" : e.code })), { statusOnly: true })
    for (const [name, value] of [["unknown mode", { mode: "nope", sessionID: sessions.root }], ["no session", { mode: "developer-probe" }],
      ["numeric session", { mode: "browser-claim", sessionID: 1 }], ["long session", { mode: "browser-probe", sessionID: "s".repeat(257) }],
      ["array body", [1]], ["human answer", { mode: "human-answer-verify", sessionID: sessions.root, command: {} }]])
      await step(name, () => post(value))

    answer({ "developer.status": fail("Fixture window closed") })
    for (const session of ["missing", "foreign", "root", "subfolder"]) await step(`developer-probe ${session}`, () => bridge("developer-probe", sessions[session]))
    await step("preferences claim missing", () => post({ mode: "browser-claim", sessionID: sessions.missing, purpose: "mission-preferences" }))
    await step("preferences claim foreign", () => post({ mode: "browser-claim", sessionID: sessions.foreign, purpose: "mission-prepare" }))
    await step("profile defaults foreign", () => bridge("mission-input", sessions.foreign, { kind: "profile-defaults", input: {} }))
    await step("mission claim missing", () => post({ mode: "browser-claim", sessionID: sessions.missing, purpose: "mission" }))

    answer({ "developer.status": ok({ status: { ...ready, state: "starting", windowId: undefined } }) })
    await step("developer-probe starting", () => bridge("developer-probe", sessions.root))
    answer({ "developer.status": ok({ status: { ...ready, windowId: 7 } }) })
    await step("developer-probe malformed status", () => bridge("developer-probe", sessions.root))
    answer({ "developer.status": ok({ status: ready, logs: [] }) })
    const target = `${ready.nativeIdentity}/${ready.runId}/${ready.windowId}/${ready.windowInstance}`
    const probe = target => post({ ...body, purpose: "target", target })
    await step("developer-probe exact target", () => probe(target))
    await step("developer-probe wrong incarnation", () => probe(`${target}-wrong`))
    await step("developer-probe invalid selector", () => probe("invalid"))
    for (const [name, command] of [["not object", "inspect"], ["unsupported", { action: "nope" }], ["click without ref", { action: "click" }],
      ["bad modifier", { action: "press", key: "Hyper+K" }], ["bad scroll", { action: "scroll", direction: "up", amount: 0 }],
      ["bad wait", { action: "wait", text: "x", timeout: 20000 }], ["long query", { action: "inspect", query: "q".repeat(201) }]])
      await step(`developer-execute ${name}`, () => bridge("developer-execute", sessions.root, command))
    if (data) await window(native, post, sessions, ready, answer)

    answer({
      "browser.probe": ({ sessionID }) => sessionID === sessions.root ? { ok: true, result: { available: true, driver: "cdp" } } : { ok: true, result: { available: false } },
      "browser.execute": ({ command }) => ["open", "navigate"].includes(command.action) ? { ok: true, result: { url: command.url } } : { ok: false, error: { message: "Fixture preview hidden" } },
      "browser.page.begin": fail("Fixture preview hidden"),
    })
    for (const session of ["root", "subfolder", "foreign"]) await step(`browser-claim ${session}`, () => post({ mode: "browser-claim", sessionID: sessions[session] }))
    await step("browser-probe root", () => bridge("browser-probe", sessions.root))
    await step("browser-probe subfolder", () => bridge("browser-probe", sessions.subfolder))
    for (const [name, command] of [["no command", undefined], ["open without url", { action: "open" }], ["bad key", { action: "press", key: "Shift++" }],
      ["open", { action: "open", url: "https://fixture.invalid/a", extra: 1 }], ["navigate", { action: "navigate", url: "http://127.0.0.1:1/" }],
      ["screenshot", { action: "screenshot" }]])
      await step(`browser-execute ${name}`, () => bridge("browser-execute", sessions.root, command))
    await step("browser-execute click", () => bridge("browser-execute", sessions.root, { action: "click", ref: "b1e1" }), { reply: true })
    await step("browser-execute snapshot", () => bridge("browser-execute", sessions.root, { action: "snapshot" }), { reply: true })
    answer({ "browser.probe": fail("Fixture host busy") })
    await step("browser-probe host error", () => bridge("browser-probe", sessions.root))

    // The TS plugin's browser client discovers this server's registration and forwards through it.
    answer({ "browser.probe": ok({ available: true }), "browser.execute": ({ command }) => ({ ok: true, result: { url: command.url, opened: command.action } }) })
    const { executeBrowserTool } = await fromDist("opencode/automation-plugin.js")
    const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, HOME: process.env.HOME }
    if (process.platform === "win32") process.env.LOCALAPPDATA = fixture.env.LOCALAPPDATA
    else { delete process.env.XDG_RUNTIME_DIR; process.env.HOME = fixture.root }
    const nodeFetch = globalThis.fetch
    globalThis.fetch = (input, init) => /^http:\/\/127\.0\.0\.1:\d+\/api\/opencode-plugin\/automation$/.test(String(input)) ? loopbackFetch(String(input), init) : nodeFetch(input, init)
    try {
      // Rust re-serializes the host's result with sorted keys: the text is compared parsed.
      const parsed = text => { try { return JSON.parse(text) } catch { return text } }
      const settle = p => p.then(value => ({ value: { ...value, content: parsed(value.content) } }), error => ({ error: String(error.message) }))
      await step("plugin open", async () => settle(executeBrowserTool(sessions.root, { action: "open", url: "https://fixture.invalid/p" })))
      await step("plugin foreign", async () => settle(executeBrowserTool(sessions.foreign, { action: "navigate", url: "https://fixture.invalid/q" })))
    } finally {
      globalThis.fetch = nodeFetch
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  } catch (error) {
    error.partial = steps
    throw error
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" }).catch(() => {})
  }
  return { compared: { steps }, counts: { steps: steps.length } }
}
