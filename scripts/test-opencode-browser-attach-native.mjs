// Isolated native contract: a non-OpenCode client attaches as the desktop browser of a session
// (`experimental.browser` RPC, version 4) and answers the commands a Code Mode call dispatches.
// Usage: node scripts/test-opencode-browser-attach-native.mjs <absolute-cli>
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Service } from "@opencode/client/service"
import { withProductRuntime } from "./native-product-fixture.mjs"

const code = `
const state = await tools.browser.tabs.list({});
const tabID = state.tabs[0].id;
const snap = await tools.browser.snapshot({ tabID });
const clicked = await tools.browser.click({ tabID, ref: "e2" });
return { tabs: state.tabs.length, content: snap.content, url: clicked.url };
`
const tab = { id: "tab_00000000-0000-4000-8000-000000000001", url: "http://127.0.0.1:9/page", title: "Fixture", loading: false, canGoBack: false, canGoForward: false, generation: 1 }

await withProductRuntime(process.argv[2], async ({ root }) => {
  const directory = path.join(root, "browser-model")
  await mkdir(directory)
  await writeFile(path.join(directory, "index.ts"), `export default { id: "browser-model-fixture", async setup(ctx) {
    const seen = new Set();
    await ctx.session.hook("http.response", async event => {
      if (event.kind !== "primary" || seen.has(event.sessionID)) return;
      seen.add(event.sessionID);
      await event.response.body?.cancel();
      const chunk = (delta, finish_reason = null) => "data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\\n\\n";
      const call = { index: 0, id: "call_browser", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: ${JSON.stringify(code)} }) } };
      event.response = new Response(chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
    });
  } }`)
  return { plugins: [directory] }
}, async ({ client, root, requests, connection }) => {
  const { endpoint } = connection
  const headers = { ...Service.headers(endpoint), "content-type": "application/json" }
  const location = `location[directory]=${encodeURIComponent(root)}`
  const rpc = (method, input, signal) => fetch(`${endpoint.url}/api/rpc/experimental.browser/${method}?${location}`,
    { method: "POST", headers, body: JSON.stringify({ input }), signal }).then(async response => {
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(`${method} ${response.status} ${JSON.stringify(body)}`)
    return body?.output
  })
  const session = await client.session.create({ location: { directory: root } })
  // The Location activates its plugins after the first request that names it.
  const ready = Date.now() + 30_000
  for (;;) {
    const listed = await fetch(`${endpoint.url}/api/plugin?${location}`, { headers }).then(response => response.json())
    const browser = listed.data.find(plugin => plugin.id === "opencode.browser")
    if (browser?.state?.status === "active") break
    assert(Date.now() < ready, `the native browser plugin activates: ${JSON.stringify(browser ?? listed.data.map(plugin => plugin.id))}`)
    await delay(100)
  }
  const connectionID = crypto.randomUUID()
  const attachment = new AbortController(), events = new AbortController()
  const seen = []
  let attached = false
  // The desktop subscribes to control events before it attaches.
  const stream = await fetch(`${endpoint.url}/api/event?${location}`, { headers, signal: events.signal })
  assert(stream.ok, `event stream ${stream.status}`)
  const listening = (async () => {
    const decoder = new TextDecoder(); let buffer = ""
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("")
        if (!data) continue
        const event = JSON.parse(data)
        if (event.type !== "rpc.experimental.browser.control" || event.data?.connectionID !== connectionID) continue
        const control = event.data
        if (control.type === "attached") { attached = true; await rpc("state", { sessionID: session.id, connectionID, state: { tabs: [tab], focusedTabID: tab.id } }); continue }
        if (control.type !== "command") continue
        const command = await rpc("command", { sessionID: session.id, connectionID, requestID: control.requestID })
        seen.push(command.action.type)
        const value = command.action.type === "tabs.list" ? { tabs: [tab], focusedTabID: tab.id }
          : command.action.type === "snapshot" ? { tab, content: '- button "Go" [ref=e2]', truncated: false }
          : command.action.type === "click" ? { ...tab, url: "http://127.0.0.1:9/done" }
          : undefined
        const outcome = value === undefined ? { type: "failure", code: "unsupported", message: `browser.${command.action.type} is unsupported` }
          : { type: "success", result: { value, files: [] } }
        await rpc("result", { sessionID: session.id, connectionID, requestID: control.requestID, outcome })
      }
    }
  })().catch(error => { if (!events.signal.aborted) listenError = error })
  let listenError
  const holding = rpc("attach", { sessionID: session.id, connectionID, version: 4 }, attachment.signal).catch(error => error)
  try { await run() } finally { attachment.abort(); events.abort(); await Promise.allSettled([holding, listening]) }
  if (listenError) throw listenError
  console.log("PASS: a non-OpenCode client attaches as the session's browser and serves Code Mode browser calls")

  async function run() {
  const deadline = Date.now() + 15_000
  while (!attached) {
    if (listenError) throw listenError
    assert(Date.now() < deadline, `attached control; attach: ${await Promise.race([holding, delay(1).then(() => "pending")])}`); await delay(25)
  }
  await client.session.prompt({ sessionID: session.id, text: "Use the browser." })
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) })
  const offered = requests.find(request => request.tools?.some(tool => tool.function?.name === "execute"))
  assert(offered, "native execute is available")
  const messages = (await client.message.list({ sessionID: session.id, order: "asc", limit: 100 })).data
  const part = messages.flatMap(message => message.type === "assistant" ? message.content : []).find(item => item.type === "tool" && item.name === "execute")
  assert(part, "the execute call ran")
  const text = part.state.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? ""
  console.log(JSON.stringify({ version: (await client.server.info()).version, status: part.state.status, seen, text: text.slice(0, 600) }))
  assert.equal(part.state.status, "completed", text)
  assert.deepEqual(seen, ["tabs.list", "snapshot", "click"])
  assert.deepEqual(JSON.parse(text), { tabs: 1, content: '- button "Go" [ref=e2]', url: "http://127.0.0.1:9/done" })
  }
})
