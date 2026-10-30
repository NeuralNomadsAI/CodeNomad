// The Design agent and skills, copied unchanged into a project's `.opencode/` (use without CodeNomad),
// are discovered by OpenCode, keep their notices out of the model text, and stay unlisted but loadable.
// Usage: node --import tsx scripts/test-design-content-native.mjs <absolute-cli>
import assert from "node:assert/strict"
import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { DESIGN_CONTENT_MARK, DESIGN_SKILL_IDS, DESIGN_SOURCE_FILES, parseDesignContent } from "../packages/server/src/opencode/design/content.ts"

const design = fileURLToPath(new URL("../packages/server/src/opencode/design/", import.meta.url))
const read = file => readFile(path.join(design, file), "utf8")
const content = parseDesignContent({
  agent: await read(DESIGN_SOURCE_FILES.agent),
  skills: Object.fromEntries(await Promise.all(DESIGN_SKILL_IDS.map(async id => [id, await read(DESIGN_SOURCE_FILES.skill(id))]))),
  notice: await read(DESIGN_SOURCE_FILES.notice),
  apacheLicense: await read(DESIGN_SOURCE_FILES.apacheLicense),
})
let project

await withProductRuntime(process.argv[2], async ({ root }) => {
  project = path.join(root, "project")
  await mkdir(project)
  await cp(path.join(design, "opencode"), path.join(project, ".opencode"), { recursive: true })
  assert.ok((await readdir(path.join(project, ".opencode"))).includes("NOTICE.md"), "the notices are copied with the files")
  return {}
}, async ({ client, requests }) => {
  const location = { directory: project }
  await client.location.get({ location })
  const deadline = Date.now() + 30_000
  let agents = [], skills = []
  while (Date.now() < deadline) {
    ;[{ data: agents }, { data: skills }] = await Promise.all([client.agent.list({ location }), client.skill.list({ location })])
    if (agents.some(agent => agent.id === "design") && DESIGN_SKILL_IDS.every(id => skills.some(skill => skill.id === id))) break
    await delay(100)
  }
  const agent = agents.find(item => item.id === "design")
  assert.ok(agent, "OpenCode discovers the Design agent")
  assert.equal(agent.mode, "primary")
  assert.equal(agent.description, content.agent.description)
  assert.equal(agent.system, content.agent.system, "the system prompt is the file body, without the notice")
  assert.ok(agent.system.startsWith(`${DESIGN_CONTENT_MARK}\n`))
  for (const expected of content.skills) {
    const skill = skills.find(item => item.id === expected.id)
    assert.ok(skill, `OpenCode discovers ${expected.id}`)
    assert.equal(skill.name, expected.name)
    assert.equal(skill.description, expected.description)
    assert.equal(skill.autoinvoke, false, `${expected.id} is never listed automatically`)
    assert.equal(skill.content.trim(), expected.content, `${expected.id} content is the file body, without the notice`)
  }

  const session = await client.session.create({ location, agent: "design" })
  await client.session.prompt({ sessionID: session.id, text: "Load your core skill.", skills: [{ id: "design-core" }] })
  await client.session.wait({ sessionID: session.id })
  const sent = JSON.stringify(requests)
  assert.ok(sent.includes(DESIGN_CONTENT_MARK), "the Design system prompt reaches the model")
  assert.ok(sent.includes("This skill holds the method every Design recipe follows."), "design-core loads by identifier")
  assert.doesNotMatch(sent, /<id>design-[a-z-]+<\/id>/, "no Design skill is listed in the available skills")
  assert.doesNotMatch(sent, /Leonxlnx|Open Design contributors/, "licence notices stay in the files, out of the model text")
  console.log("PASS native Design content: project .opencode copy discovered (agent and 7 skills), notices outside model text, skills unlisted and loadable by id")
}, { projectConfig: true })
