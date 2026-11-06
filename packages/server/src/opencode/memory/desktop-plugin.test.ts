import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { AUTOMATION_BRIDGE_PATH, createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { desktopPlugin } from "./desktop-plugin"

type Definition = {
  name: string
  options: { namespace: string; codemode: boolean }
  input: { properties: object; additionalProperties: boolean }
  execute(input: unknown, tool: { sessionID: string }): Promise<{ content: string }>
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-memory-plugin-"))
  const previous = Object.fromEntries(["LOCALAPPDATA", "XDG_RUNTIME_DIR", "WSL_DISTRO_NAME"].map(key => [key, process.env[key]]))
  process.env.LOCALAPPDATA = root
  process.env.XDG_RUNTIME_DIR = root
  delete process.env.WSL_DISTRO_NAME
  const app = Fastify(), calls: Array<{ sessionID: string; command: unknown }> = [], definitions: Definition[] = []
  let response: { status: number; body: object } | "lost" = { status: 200, body: { result: { entries: [] } } }
  let probes = 0, disposed = 0
  const registration = createAutomationBridgeRegistration("http://127.0.0.1")
  app.post(AUTOMATION_BRIDGE_PATH, (request, reply) => {
    assert.equal(request.headers["x-codenomad-automation-token"], registration.token)
    const body = request.body as { mode: string; sessionID: string; command: unknown }
    if (body.mode === "memory-probe") { probes++; return { result: { available: true } } }
    assert.equal(body.mode, "memory-input")
    calls.push({ sessionID: body.sessionID, command: body.command })
    if (response === "lost") { reply.hijack(); reply.raw.destroy(); return }
    return reply.code(response.status).send(response.body)
  })
  const url = await app.listen({ host: "127.0.0.1", port: 0 })
  const remove = await publishAutomationBridge({ ...registration, url: `${url}${AUTOMATION_BRIDGE_PATH}` })
  const presence = path.join(root, "presence")
  await mkdir(presence)
  await writeFile(path.join(presence, `${randomUUID()}.lease`), "")
  const plugin = desktopPlugin(presence)
  const cleanup = await plugin.setup!({ tool: { transform: async (callback: (editor: { add(definition: Definition): void }) => void) => {
    callback({ add: definition => { definitions.push(definition) } })
    return { dispose: async () => { disposed++ } }
  } } } as never) as () => Promise<void>
  t.after(async () => {
    await cleanup(); await remove(); await app.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(plugin.id, "codenomad.memory")
  assert.equal(definitions.length, 1)
  const tool = definitions[0]!
  assert.equal(tool.name, "memory")
  assert.deepEqual(tool.options, { namespace: "codenomad", codemode: false })
  assert.equal(tool.input.additionalProperties, false)
  assert.equal("sessionId" in tool.input.properties, false)
  assert.equal("sessionID" in tool.input.properties, false)
  return { tool, calls, setResponse(value: typeof response) { response = value }, cleanup,
    probes: () => probes, disposed: () => disposed,
    execute: (input: object) => tool.execute({ scope: "global", ...input }, { sessionID: "ses_native" }) }
}

test("native memory tools route every action using only the execution session and dispose with presence", async t => {
  const f = await fixture(t)
  await f.execute({ action: "list" })
  for (const query of ["entry_id", "Exact title"]) await f.execute({ action: "read", query })
  const content = { title: "Editor", type: "preference", text: "Use Vim." }
  await f.execute({ action: "save", ...content })
  await f.execute({ action: "save", ...content, id: "entry_id", revision: "a".repeat(64) })
  await f.execute({ action: "delete", id: "entry_id", revision: "b".repeat(64) })
  assert.deepEqual(f.calls, [
    { sessionID: "ses_native", command: { action: "list", scope: "global" } },
    ...["entry_id", "Exact title"].map(query => ({ sessionID: "ses_native", command: { action: "read", scope: "global", query } })),
    { sessionID: "ses_native", command: { action: "save", scope: "global", content } },
    { sessionID: "ses_native", command: { action: "save", scope: "global", id: "entry_id", revision: "a".repeat(64), content } },
    { sessionID: "ses_native", command: { action: "delete", scope: "global", id: "entry_id", revision: "b".repeat(64) } },
  ])
  const before = f.probes()
  for (const input of [{ action: "list", sessionID: "forged" }, { action: "list", sessionId: "forged" },
    { action: "delete", id: "entry_id" }, { action: "save", title: "Missing text" }, { action: "list", projectId: "forged" }]) {
    await assert.rejects(f.execute(input), /Invalid memory input/)
  }
  assert.equal(f.probes(), before, "invalid or forged input never reaches discovery")
  await f.cleanup()
  assert.equal(f.disposed(), 1)
})

test("agent-facing errors preserve capacity titles and never replay uncertain writes", async t => {
  const f = await fixture(t)
  f.setResponse({ status: 403, body: { code: "disabled", error: "private path" } })
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /disabled.*Preferences/)
  f.setResponse({ status: 409, body: { code: "full", titles: ["Editor", "Project checks"] } })
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /Merge or delete.*Editor.*Project checks/)
  f.setResponse({ status: 409, body: { code: "conflict" } })
  await assert.rejects(f.execute({ action: "delete", id: "entry_id", revision: "a".repeat(64) }), /read the current entry/)
  f.setResponse("lost")
  const before = f.calls.length
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /Do not replay.*List\/read/)
  assert.equal(f.calls.length, before + 1, "a lost mutation response produces exactly one dispatch")
  await assert.rejects(f.execute({ action: "list" }), /unavailable/)
})
