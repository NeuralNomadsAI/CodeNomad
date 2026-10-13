import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"

await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  const directory = path.join(configDirectory, "skills", "fixture-review")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: Fixture Review\ndescription: Synthetic skill for attachment validation\n---\nNATIVE_SKILL_BODY_CANARY: Review only fixture content.\n")
  return { skills: [path.dirname(directory)] }
}, async ({ client, root, requests }) => {
  await client.location.get({ location: { directory: root } })
  const session = await client.session.create({ location: { directory: root } })
  let { data } = await client.skill.list({ location: { directory: root } })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !data.some(skill => skill.id === "fixture-review")) {
    await delay(100)
    ;({ data } = await client.skill.list({ location: { directory: root } }))
  }
  const skill = data.find(skill => skill.id === "fixture-review")
  assert.equal(skill?.name, "Fixture Review")
  await client.session.prompt({ sessionID: session.id, text: "Review the fixture", skills: [{ id: skill.id }] })
  await client.session.wait({ sessionID: session.id })
  const messages = await client.message.list({ sessionID: session.id, order: "asc", limit: 100 })
  const user = messages.data.find(message => message.type === "user")
  assert.equal(user.skills[0].id, skill.id)
  assert.equal(user.skills[0].name, "Fixture Review")
  assert.match(JSON.stringify(requests), /NATIVE_SKILL_BODY_CANARY/)
  assert.equal(user.text, "Review the fixture", "UI must not inline the skill body")
  await client.session.prompt({ sessionID: session.id, text: "Queued review", skills: [{ id: skill.id }], delivery: "queue", resume: false })
  const inbox = await client.session.inbox.list({ sessionID: session.id })
  assert.equal(inbox[0].payload.skills[0].id, skill.id)
  console.log("PASS native catalog, skill-id attachment, native expansion, history and queued payload")
})
