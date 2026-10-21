// Isolated native execute regression for upstream #54276. No real provider/data.
// Usage: node --import tsx scripts/test-codemode-jobs-native.mjs <absolute-cli>
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"

// Long enough to cross the interpreter's Effect preemption boundary mid-job.
const code = `
let total = 0;
const work = async () => { await null; for (let i = 0; i < 1000; i++) total = total + 1; };
await Promise.all([work(), work()]);
let count = 0;
const start = async () => { for (let i = 0; i < 1000; i++) count = count + 1; await null; };
const started = start();
const beforeAwait = count;
await started;
return { total, beforeAwait, count };
`
await withProductRuntime(process.argv[2], async ({ root }) => {
  const directory = path.join(root, "codemode-fixture")
  await mkdir(directory)
  await writeFile(path.join(directory, "index.ts"), `export default { id: "codemode-jobs-fixture", async setup(ctx) {
    const seen = new Set();
    await ctx.session.hook("http.response", async event => {
      if (event.kind !== "primary" || seen.has(event.sessionID)) return;
      seen.add(event.sessionID);
      await event.response.body?.cancel();
      const chunk = (delta, finish_reason = null) => "data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\\n\\n";
      const call = { index: 0, id: "call_jobs", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: ${JSON.stringify(code)} }) } };
      event.response = new Response(chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
    });
  } }`)
  return { plugins: [directory] }
}, async ({ client, root, requests }) => {
  const session = await client.session.create({ location: { directory: root } })
  await client.session.prompt({ sessionID: session.id, text: "Run the synthetic JavaScript job-ordering check." })
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
  assert(requests.some(request => request.tools?.some(tool => tool.function?.name === "execute")), "native execute is available")
  const messages = (await client.message.list({ sessionID: session.id, order: "asc", limit: 100 })).data
  const tool = messages.flatMap(message => message.type === "assistant" ? message.content : []).find(part => part.type === "tool" && part.name === "execute")
  assert(tool, "real native execute tool ran")
  assert.equal(tool.state.status, "completed")
  const text = tool.state.content.filter(part => part.type === "text").map(part => part.text).join("\n")
  const result = JSON.parse(text)
  console.log(JSON.stringify({ version: (await client.server.info()).version, result }))
  assert.deepEqual(result, { total: 2000, beforeAwait: 1000, count: 1000 }, "native Code Mode jobs preserve JavaScript run-to-completion semantics")
  console.log("PASS: concurrent Promise updates and synchronous async-function prefix preserve their results")
})
