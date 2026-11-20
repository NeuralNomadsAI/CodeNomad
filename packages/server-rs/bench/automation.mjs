// Mode `automation`: each server's automation bridge with a scripted desktop host on its native
// channel. Registration, token and body refusals, session ownership (root, subfolder, foreign,
// missing), Missions not-owner answers, browser claim/probe/execute forwarding with the exact
// native requests, the window status checks and command validation, then the TS plugin's own
// browser client. Steps that need the page engine (A/B choice) compare their status only.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fromDist } from "./fixtures.mjs"
import { bridgeClient, loopbackFetch } from "./memory.mjs"

export const comparable = value => value.compared

export async function run({ call, fixture, root, pid, native, folder }) {
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
  // `statusOnly`: the reference drives the page engine there; Rust refuses until B lands.
  const step = async (name, request, { statusOnly = false } = {}) => {
    native.requests.length = 0
    const reply = await request()
    steps.push(statusOnly ? { name, status: reply.status } : { name, ...scrub(reply), native: scrub(native.requests) })
    return reply
  }
  const answer = replies => { native.answer = (method, params) => replies[method]?.(params) ?? { ok: false, error: { message: `No fixture answer for ${method}` } } }
  const fail = message => () => ({ ok: false, error: { code: "fixture", message } })
  const ok = result => () => ({ ok: true, result })
  const ready = { state: "ready", runId: "run-1", nativeIdentity: "tauri:fixture", cdpUrl: "http://127.0.0.1:9", windowId: "window-1" }
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
    answer({ "developer.status": ok({ status: { ...ready, cdpUrl: 7 } }) })
    await step("developer-probe malformed status", () => bridge("developer-probe", sessions.root))
    answer({ "developer.status": ok({ status: ready, logs: [] }) })
    for (const [name, command] of [["not object", "inspect"], ["unsupported", { action: "nope" }], ["click without ref", { action: "click" }],
      ["bad modifier", { action: "press", key: "Hyper+K" }], ["bad scroll", { action: "scroll", direction: "up", amount: 0 }],
      ["bad wait", { action: "wait", text: "x", timeout: 20000 }], ["long query", { action: "inspect", query: "q".repeat(201) }]])
      await step(`developer-execute ${name}`, () => bridge("developer-execute", sessions.root, command))
    await step("developer-probe ready", () => bridge("developer-probe", sessions.root), { statusOnly: true })
    await step("developer-execute inspect", () => bridge("developer-execute", sessions.root, { action: "inspect" }), { statusOnly: true })

    answer({
      "browser.probe": ({ sessionID }) => sessionID === sessions.root ? { ok: true, result: { available: true, driver: "cdp" } } : { ok: true, result: { available: false } },
      "browser.execute": ({ command }) => command.action === "screenshot" ? { ok: false, error: { message: "Fixture preview hidden" } } : { ok: true, result: { url: command.url } },
      "browser.page.begin": fail("Fixture preview hidden"),
    })
    for (const session of ["root", "subfolder", "foreign"]) await step(`browser-claim ${session}`, () => post({ mode: "browser-claim", sessionID: sessions[session] }))
    await step("browser-probe root", () => bridge("browser-probe", sessions.root))
    await step("browser-probe subfolder", () => bridge("browser-probe", sessions.subfolder))
    for (const [name, command] of [["no command", undefined], ["open without url", { action: "open" }], ["bad key", { action: "press", key: "Shift++" }],
      ["open", { action: "open", url: "https://fixture.invalid/a", extra: 1 }], ["navigate", { action: "navigate", url: "http://127.0.0.1:1/" }],
      ["screenshot", { action: "screenshot" }]])
      await step(`browser-execute ${name}`, () => bridge("browser-execute", sessions.root, command))
    await step("browser-execute click", () => bridge("browser-execute", sessions.root, { action: "click", ref: "b1e1" }), { statusOnly: true })
    await step("browser-execute snapshot", () => bridge("browser-execute", sessions.root, { action: "snapshot" }), { statusOnly: true })
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
