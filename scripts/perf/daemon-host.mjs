import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fixtureEnvironment } from "../native-product-fixture.mjs"
import { launchFixture } from "../../packages/rune-app/fixtures/fixture-host.mjs"
import { assertNoSystemOpenCodeConfig, attestNative } from "../../packages/rune-app/fixtures/live-access.mjs"
import {createAttestedRelay,fixtureFetch,redactSecrets,RELAY_PLACEHOLDER_PASSWORD,resolveLocalExecutable} from "../native-fixture-http.mjs"
import { privatePath } from "./isolation.mjs"
import { json, now, sleep } from "./lib.mjs"

export async function withDaemon(cli, root, chunks, run, {pruning: pruningEnabled = false} = {}) {
  cli = resolveLocalExecutable(cli, "OpenCode binary")
  await assertNoSystemOpenCodeConfig()
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
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  const gitEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"),
    GIT_TEMPLATE_DIR: "", GIT_CEILING_DIRECTORIES: root,
  }
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=", ...args], { cwd: project, env: gitEnv, windowsHide: true, timeout: 30_000 })
  git("init", "-q", "--template=")
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
  let pruning
  try {
    if(pruningEnabled){const {preparePruning}=await import('./pruning.mjs');pruning=await preparePruning(root,env.OPENCODE_CONFIG_DIR,gitEnv)}
  } catch(error){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));throw error}
  let daemon, attested, nativeRelay
  try {
    const childEnv = { ...env, ...gitEnv }
    const daemonEnv = { ...childEnv, OPENCODE_SERVER_PASSWORD: password }
    daemon = launchFixture(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {cwd: project, env: daemonEnv, redact: [password]})
    const url = await daemon.ready(stdout => stdout.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\/?\r?\n/m)?.[1], 60_000)
    const pid = await daemon.pid()
    attested = await attestNative(url, daemon.child, authorization, fixtureFetch, pid)
    nativeRelay = await createAttestedRelay(url, pid, { requireClientAttestation: true, injectAuthorization: authorization })
    const {send} = attested
    const call = (method, route, body) => json(send, route, {method, body})
    await pruning?.activate({project,url,authorization,send},()=>assert.equal(daemon.child.exitCode,null,'Owned pruning daemon exited'))
    await run({ project, env: childEnv, url, relayUrl: nativeRelay.origin, relayPassword: RELAY_PLACEHOLDER_PASSWORD, allowRelayClient: nativeRelay.allowClientPid, password, authorization, call, send, markers, pid, cli, pruning,
      arm(pass, size) {
        const { promise: start, resolve: release } = Promise.withResolvers()
        batch = { pass, size, start, release, ready: new Set() }
      },
    })
    if (providerError) throw providerError
  } finally {
    try {try{await nativeRelay?.close()}finally{try{await daemon?.stop()}finally{try{await attested?.close()}finally{await pruning?.close()}}}} finally {
      provider.closeAllConnections()
      batch?.release()
      await new Promise(resolve => provider.close(resolve))
      await writeFile(path.join(root, "daemon.log"), redactSecrets(daemon?.output()??"", [password]))
    }
  }
}
