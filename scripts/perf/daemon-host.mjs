import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fixtureEnvironment } from "../native-product-fixture.mjs"
import { stopFixtureChild } from "../native-fixture-guards.mjs"
import { privatePath } from "./isolation.mjs"
import { json, now, sleep } from "./lib.mjs"

export async function withDaemon(cli, root, chunks, run) {
  assert(path.isAbsolute(cli), "Pass the absolute path to the pinned OpenCode binary")
  root = privatePath(root)
  const project = privatePath(path.join(root, "project"))
  await mkdir(project, { recursive: true })
  for (let i = 0; i < 3; i++) {
    await writeFile(path.join(project, `module-${i}.ts`), Array.from({ length: 120 }, (_, l) => `export const value${i}_${l} = ${l} // fixture line ${l}`).join("\n"))
  }
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const env = await fixtureEnvironment(root, {
    OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_SERVER_PASSWORD: password,
  })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  const git = (...args) => execFileSync("git", args, { cwd: project, env, windowsHide: true })
  git("init", "-q")
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture")

  const markers = new Map(), liveToolTurns = new Set()
  let batch
  const words = ["alpha beta gamma delta epsilon", "render store event frame patch", "eta theta iota kappa lambda"]
  let providerError
  const provider = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const { messages, stream } = JSON.parse(raw)
      if (!stream) {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
        return
      }
      // Native instructions can follow the prompt as distinct synthetic messages.
      const user = messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(c => c.text ?? "").join(" "))
        .findLast(text => /^\s*(?:BENCH:[A-Z]{2}:\d+ LIVE\b|SEED\d+\b)/.test(text)) ?? ""
      const tag = /^\s*BENCH:([A-Z]{2}):(\d+) LIVE/.exec(user)
      const seedTurn = /^\s*SEED(\d+)/.exec(user)
      const tools = tag ? (liveToolTurns.has(tag[0]) ? 0 : 3) : seedTurn && Number(seedTurn[1]) % 5 === 0 && messages.at(-1)?.role !== "tool" ? 1 : 0
      res.setHeader("Content-Type", "text/event-stream")
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`)
      if (tools) {
        if (tag) liveToolTurns.add(tag[0])
        send({ role: "assistant", content: "" })
        for (let i = 0; i < tools; i++) send({ tool_calls: [{ index: i, id: `call_${randomUUID().slice(0, 8)}`, type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: path.join(project, `module-${i}.ts`) }) } }] })
        send({}, "tool_calls")
      } else if (tag) {
        const [, code, pass] = tag
        assert.equal(batch?.pass, pass, "Unexpected benchmark workload pass")
        batch.ready.add(code)
        if (batch.ready.size === batch.size) batch.release()
        await batch.start
        send({ role: "assistant", content: "" })
        for (let i = 0; i < chunks && !res.destroyed; i++) {
          let text = (i % 40 === 0 ? `\n\n### Part ${i / 40}\n\n` : " ") + words[i % words.length]
          if (i % 60 === 30) text += `\n\n\`\`\`ts\nfunction f${i}() { return ${i} }\n\`\`\`\n\n`
          const marker = i % 8 === 0 ? `MK${code}${pass.padStart(2, "0")}${String(i).padStart(4, "0")}K` : undefined
          if (marker) markers.set(marker, now())
          send({ content: marker ? `${text} ${marker} ` : text })
          await sleep(15)
        }
        send({}, "stop")
      } else {
        send({ role: "assistant", content: `Seed answer. ${words.join(" ").repeat(4)}\n\n- ${words[0]}\n- ${words[1]}\n\n\`\`\`ts\nconst x = 100\n\`\`\`\n${words.join(" ").repeat(3)}` })
        send({}, "stop")
      }
      res.end("data: [DONE]\n\n")
    } catch (error) {
      providerError = error
      res.destroy(error)
    }
  })
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", providers: { fixture: {
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} },
  } } })
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: project, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  let output = "", spawnError
  child.on("error", error => { spawnError = error })
  for (const pipe of [child.stdout, child.stderr]) pipe.on("data", bytes => { output = (output + bytes).slice(-500_000) })
  try {
    const deadline = Date.now() + 60_000
    let url
    while (!(url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || Date.now() >= deadline) throw Error(output.slice(-3000))
      await sleep(50)
    }
    const call = (method, route, body) => json(`${url}${route}`, { method, body, headers: { authorization } })
    const info = await call("GET", "/api/info")
    assert.equal(info.pid, child.pid, "Bench daemon did not prove its identity")
    await run({ project, env, url, password, authorization, call, markers, pid: child.pid, cli,
      arm(pass, size) {
        const { promise: start, resolve: release } = Promise.withResolvers()
        batch = { pass, size, start, release, ready: new Set() }
      },
    })
    if (providerError) throw providerError
  } finally {
    try { await stopFixtureChild(child, stopped) } finally {
      provider.closeAllConnections()
      batch?.release()
      await new Promise(resolve => provider.close(resolve))
      await writeFile(path.join(root, "daemon.log"), output.replaceAll(password, "<fixture password>"))
    }
  }
}
