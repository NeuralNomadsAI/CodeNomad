// Isolated native Promise-tool failure/permission boundary; local provider only.
import assert from "node:assert/strict"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"

await withProductRuntime(process.argv[2], async ({ root }) => {
  const plugin = path.join(root, "promise-failure-fixture")
  await mkdir(plugin)
  await writeFile(path.join(plugin, "index.ts"), `import { writeFile } from "node:fs/promises";
export default { id: "promise-failure-fixture", async setup(ctx) {
    const seen = new Set(); let cases = 0;
    await ctx.tool.transform(editor => {
      editor.add({ name: "fixture_throw", description: "Synthetic failure", input: { type: "object" },
        options: { codemode: false }, execute: async () => { throw new Error("FIXTURE_THROW") } });
      editor.add({ name: "fixture_deny", description: "Synthetic permission denial", input: { type: "object" },
        options: { codemode: false }, execute: async (_input, tool) => {
          await ctx.permission.assert({ sessionID: tool.sessionID, action: "fixture_denied", resources: ["fixture-only"] });
          await writeFile(${JSON.stringify(path.join(root, "must-not-exist"))}, "unsafe");
          return { content: "unexpected" };
        } });
    });
    await ctx.session.hook("http.response", async event => {
      if (event.kind !== "primary" || seen.has(event.sessionID)) return;
      seen.add(event.sessionID);
      const mode = cases++;
      const name = mode === 1 ? "fixture_deny" : "fixture_throw";
      const argumentsText = mode === 2 ? "{ invalid json" : "{}";
      await event.response.body?.cancel();
      const chunk = (delta, finish_reason = null) => "data: " + JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      }) + "\\n\\n";
      event.response = new Response(chunk({ role: "assistant" }) + chunk({ tool_calls: [{
        index: 0, id: "fixture-call", type: "function", function: { name, arguments: argumentsText },
      }] }) + chunk({}, "tool_calls") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
    });
  } }`)
  return { plugins: [plugin] }
}, async ({ client, root }) => {
  for (const mode of ["throw", "deny", "malformed"]) {
    const name = mode === "deny" ? "fixture_deny" : "fixture_throw"
    const session = await client.session.create({ location: { directory: root },
      permissions: [{ action: "fixture_denied", resource: "*", effect: "deny" }] })
    await client.session.prompt({ sessionID: session.id, text: `Exercise the synthetic ${name} case.` })
    await client.session.wait({ sessionID: session.id })
    const messages = (await client.message.list({ sessionID: session.id, order: "asc", limit: 100 })).data
    const tools = messages.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : [])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, name)
    assert.equal(tools[0].state.status, "error")
    if (mode === "throw") assert(JSON.stringify(tools[0].state).includes("FIXTURE_THROW"))
    if (mode === "deny") assert.equal(tools[0].state.error.type, "permission.rejected")
    if (mode === "malformed") {
      assert.equal(tools[0].state.error.type, "tool.input-json")
      assert(tools[0].state.error.message.includes("{ invalid json"))
      assert.equal(tools[0].state.error.message.includes("FIXTURE_THROW"), false, "Malformed arguments must not execute the tool")
    }
    assert.equal(messages.filter(message => message.type === "user").length, 1)
    assert.equal(messages.filter(message => message.type === "idle").at(-1)?.outcome, "succeeded", "Tool failure must not crash the native execution")
    assert.equal((await client.permission.list({ sessionID: session.id })).length, 0)
  }
  await assert.rejects(access(path.join(root, "must-not-exist")), { code: "ENOENT" })
  console.log("PASS: rejected Promise tools settle error while the execution completes; native denial prevents their side effect")
})
