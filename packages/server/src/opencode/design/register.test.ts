import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { Effect, Exit, Scope } from "effect"
import { desktopPlugin } from "../session-pruning/desktop-plugin"
import { DESIGN_CONTENT_MARK, DESIGN_SKILL_IDS, DESIGN_SOURCE_FILES, parseDesignContent, type DesignSources } from "./content"
import { registerDesign } from "./register"

// tsx cannot import `.md`: the checkout's native files are parsed as the bundle does.
const read = (file: string) => readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8")
const designContent = parseDesignContent({
  agent: await read(DESIGN_SOURCE_FILES.agent),
  skills: Object.fromEntries(await Promise.all(DESIGN_SKILL_IDS.map(async id => [id, await read(DESIGN_SOURCE_FILES.skill(id))]))) as DesignSources["skills"],
  notice: await read(DESIGN_SOURCE_FILES.notice),
  apacheLicense: await read(DESIGN_SOURCE_FILES.apacheLicense),
})
const load = async () => designContent

type Agent = { id: string; name?: string; mode?: string; system?: string; permissions?: unknown[] }
type Skill = { id: string; path?: string; autoinvoke?: boolean; content?: string }

// A spy plugin context: transforms are recorded and replayed in order on demand, like native state.
function spyContext() {
  const agentTransforms: Array<(editor: any) => void> = [], skillTransforms: Array<(editor: any) => void> = []
  const reloads: string[] = []
  let disposed = 0
  // Native transforms are scoped registrations, released with the plugin scope.
  const transform = (list: Array<(editor: any) => void>) => (callback: (editor: any) => void) => Effect.acquireRelease(
    Effect.sync(() => { list.push(callback); return { dispose: Effect.void } }), () => Effect.sync(() => { disposed++ }))
  const ctx = {
    agent: { transform: transform(agentTransforms), reload: () => Effect.sync(() => { reloads.push("agent") }) },
    skill: { transform: transform(skillTransforms), reload: () => Effect.sync(() => { reloads.push("skill") }) as Effect.Effect<void> },
  }
  const state = (user: { agents?: Agent[]; skills?: Skill[] } = {}) => {
    const agents = new Map<string, Agent>((user.agents ?? []).map(agent => [agent.id, agent]))
    const skills = new Map<string, Skill>((user.skills ?? []).map(skill => [skill.id, skill]))
    for (const transform of agentTransforms) transform({ get: (id: string) => agents.get(id), update: (id: string, update: (agent: Agent) => void) => {
      const agent = agents.get(id) ?? { id, permissions: [] }
      agents.set(id, agent)
      update(agent)
    } })
    for (const transform of skillTransforms) transform({ get: (id: string) => skills.get(id), add: (skill: Skill) => skills.set(skill.id, skill) })
    return { agents, skills }
  }
  return { ctx, agentTransforms, skillTransforms, reloads, state, disposed: () => disposed }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(5)
  assert(predicate(), "Expected the reconciliation to finish")
}

async function open(effect: Effect.Effect<void, never, Scope.Scope>) {
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(Scope.provide(scope)(effect))
  return () => Effect.runPromise(Scope.close(scope, Exit.void))
}

test("transforms register once at load; reconciliation reloads only on an actual change", async () => {
  const spy = spyContext()
  let wanted = true, reads = 0, released = 0
  const request = { read: async () => { reads++; return wanted }, release: () => { released++ } }
  const close = await open(registerDesign(spy.ctx as never, request, load, "/bundle/plugin.mjs", 10))
  assert.equal(spy.agentTransforms.length, 1)
  assert.equal(spy.skillTransforms.length, 1)
  assert.deepEqual(spy.reloads, [], "The initial request applies without a reload")
  const { agents, skills } = spy.state()
  assert.equal(agents.get("design")?.mode, "primary")
  assert.equal(agents.get("design")?.system, designContent.agent.system)
  assert(agents.get("design")?.system?.startsWith(`${DESIGN_CONTENT_MARK}\n`))
  assert.deepEqual([...skills.keys()], [...DESIGN_SKILL_IDS])
  for (const skill of designContent.skills) assert.equal(skills.get(skill.id)?.content, skill.content)
  assert([...skills.values()].every(skill => skill.autoinvoke === false && skill.path === "/bundle/plugin.mjs"))

  await waitFor(() => reads >= 5)
  assert.deepEqual(spy.reloads, [], "Unchanged renewals never reload")
  wanted = false
  await waitFor(() => spy.reloads.length === 2)
  assert.deepEqual(spy.reloads, ["agent", "skill"])
  assert.equal(spy.state().agents.has("design"), false)
  assert.equal(spy.state().skills.size, 0)
  const settled = reads
  await waitFor(() => reads >= settled + 3)
  assert.equal(spy.reloads.length, 2)
  wanted = true
  await waitFor(() => spy.reloads.length === 4)
  assert.equal(spy.state().agents.has("design"), true)
  assert.equal(spy.agentTransforms.length, 1, "Reconciliation never registers another transform")
  await close()
  assert.equal(spy.disposed(), 2, "Transforms are released with the plugin scope")
  assert.equal(released, 1)
  const stopped = reads
  await delay(40)
  assert.equal(reads, stopped, "No reconciliation runs after the scope closes")
})

test("the user's own design agent and design-* skills win", async () => {
  const spy = spyContext()
  const close = await open(registerDesign(spy.ctx as never, { read: async () => true, release() {} }, load, "/bundle/plugin.mjs", 1_000))
  const user = { agents: [{ id: "design", system: "USER" }], skills: [{ id: "design-core", content: "USER" }] }
  const { agents, skills } = spy.state(user)
  assert.equal(agents.get("design")?.system, "USER")
  assert.equal(skills.get("design-core")?.content, "USER")
  assert.equal(skills.size, 7)
  await close()
})

test("a failed reload is retried at the next interval", async () => {
  const spy = spyContext()
  let wanted = false, failures = 1
  spy.ctx.skill.reload = () => failures-- > 0 ? Effect.die(new Error("fixture reload failure")) : Effect.sync(() => { spy.reloads.push("skill") })
  const errors: unknown[] = []
  const close = await open(registerDesign(spy.ctx as never, { read: async () => wanted, release() {} }, load, "/p", 10, error => errors.push(error)))
  wanted = true
  await waitFor(() => spy.reloads.includes("skill"))
  assert.equal(errors.length, 1)
  assert.deepEqual(spy.reloads, ["agent", "agent", "skill"])
  await close()
})

test("content loads only once Design is requested, and a failed load is retried", async () => {
  const spy = spyContext()
  let wanted = false, calls = 0
  const flaky = async () => { if (++calls === 1) throw new Error("fixture load failure"); return designContent }
  const errors: unknown[] = []
  const close = await open(registerDesign(spy.ctx as never, { read: async () => wanted, release() {} }, flaky, "/p", 10, error => errors.push(error)))
  await delay(40)
  assert.equal(calls, 0, "Nothing loads while no backend requests Design")
  wanted = true
  await waitFor(() => spy.reloads.length === 2)
  assert.equal(calls, 2)
  assert.equal(errors.length, 1)
  assert.equal(spy.state().agents.has("design"), true)
  wanted = false
  await waitFor(() => spy.reloads.length === 4)
  wanted = true
  await waitFor(() => spy.reloads.length === 6)
  assert.equal(calls, 2, "Loaded content is reused")
  await close()
})

test("a runtime without agent or skill transforms gets no Design agent", async () => {
  let released = 0
  const close = await open(registerDesign({ agent: {}, skill: {} } as never, { read: async () => true, release: () => { released++ } }, load, "/p", 10))
  assert.equal(released, 1)
  await close()
})

test("the session-pruning plugin registers Design transforms at load, without any backend presence", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-design-load-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spy = spyContext()
  const close = await open(desktopPlugin(path.join(directory, "presence")).effect(spy.ctx as never))
  assert.equal(spy.agentTransforms.length, 1)
  assert.equal(spy.skillTransforms.length, 1)
  assert.equal(spy.state().agents.has("design"), false, "No lease requests Design")
  await close()
  assert.equal(spy.disposed(), 2)
})
