// Real isolated runtime and loopback provider; exercise the native bounded continuation policy.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"

await withProductRuntime(process.argv[2], async ({ root }) => {
  const plugin = path.join(root, "output-limit-fixture")
  await mkdir(plugin)
  await writeFile(path.join(plugin, "index.ts"), `export default { id: "output-limit-fixture", async setup(ctx) {
    await ctx.session.hook("http.response", async event => {
      if (event.kind !== "primary") return
      const text = await event.response.text()
      event.response = new Response(text.replaceAll('"finish_reason":"stop"', '"finish_reason":"length"'), {
        status: event.response.status, headers: { "content-type": "text/event-stream" },
      })
    })
  } }`)
  return { plugins: [plugin] }
}, async ({ client, root }) => {
  const session = await client.session.create({ location: { directory: root } })
  await client.session.prompt({ sessionID: session.id, text: "Return only the synthetic fixture answer." })
  await client.session.wait({ sessionID: session.id })
  const messages = (await client.message.list({ sessionID: session.id, order: "asc", limit: 100 })).data
  const assistants = messages.filter(message => message.type === "assistant")
  assert.equal(assistants.length, 3, "Native continuation must stop after two output-limit continuations")
  assert(assistants.every(message => message.finish === "length"))
  assert.equal(messages.filter(message => message.type === "user").length, 1, "The user prompt must not be replayed")
  const idle = messages.filter(message => message.type === "idle").at(-1)
  assert.equal(idle?.outcome, "failed", "Exhausted continuation must become a durable native failure")
  const state = (await client.session.active())[session.id]
  assert.equal(state, undefined, "Output-limit failure must not leave the session active")
  console.log("PASS: native length recovery is bounded, preserves a single user prompt and settles failed/idle")
})
