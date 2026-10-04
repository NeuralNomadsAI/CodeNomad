import { appendFile, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { RPC } from "./schema.mjs"

export function qualificationPlugin(token, root) {
  return { id: RPC.id, async setup(ctx) {
    // Runtime-lifetime fence, not native attestation. Native session ENV is volatile.
    const incarnation = randomUUID()
    const trace = async (kind, data) => appendFile(`${root}/hooks.jsonl`, JSON.stringify({ kind, time: Date.now(), ...data }) + "\n")
    const family = async sessionID => {
      const chain = [], seen = new Set()
      while (sessionID) {
        if (seen.has(sessionID) || chain.length > 8) throw new Error("Family cycle/budget")
        seen.add(sessionID)
        const session = await ctx.session.get({ sessionID }); chain.push(session); sessionID = session.parentID
      }
      if (chain.some(session => session.projectID !== chain[0].projectID || JSON.stringify(session.location) !== JSON.stringify(chain[0].location))) throw new Error("Foreign native family")
      return { rootID: chain.at(-1).id, chain }
    }
    const policy = async sessionID => {
      const { rootID } = await family(sessionID)
      return { rootID, ...await ctx.storage.get(`policy/${rootID}`) }
    }
    const check = async (sessionID, boundary) => {
      const value = await policy(sessionID)
      if (value.gate && value.state !== "running") {
        await trace("rejected", { sessionID, boundary, rootID: value.rootID, state: value.state, generation: value.generation })
        throw new Error("Trusted private generation gate: " + value.state)
      }
      return value
    }
    for (const hook of ["context", "model.request", "generate", "compaction"]) await ctx.session.hook(hook, async event => {
      const value = await check(event.sessionID, hook)
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.parentID && value.explicitEnvironment) {
        const receipt = await ctx.storage.get(`environment-ready/${session.id}`)
        if (receipt?.incarnation !== incarnation || receipt.generation !== value.generation) {
          await trace("environment-context-rejected", { sessionID: session.id, rootID: value.rootID, boundary: hook, reason: "Fresh owned environment admission required in current plugin lifetime/generation" })
          throw new Error("Fresh descendant environment admission required")
        }
      }
      await trace("hook", { sessionID: event.sessionID, boundary: hook, kind: event.kind ?? "primary" })
    })
    await ctx.session.hook("title", async event => { await check(event.sessionID, "title"); event.result = "Private qualification" })
    await ctx.session.hook("retry", event => { event.decision = { retry: false } })
    await ctx.session.hook("http.request", async event => {
      await check(event.sessionID, "http.request")
      event.request.headers.set("x-authority-session", event.sessionID)
      event.request.headers.set("x-authority-kind", event.kind)
      const binding = await ctx.storage.get(`current/${event.sessionID}`)
      if (binding) event.request.headers.set("x-child-call", binding.callID)
    })
    await ctx.tool.hook("execute.before", async event => { await check(event.sessionID, `tool:${event.tool}`) })
    const native = (await ctx.tool.list()).find(tool => tool.id === "subagent")
    await writeFile(`${root}/catalog.json`, JSON.stringify({ sessionMethods: Object.keys(ctx.session), toolMethods: Object.keys(ctx.tool), nativeInput: native.input, nativeOptions: native.options, agents: await ctx.agent.list() }, null, 2))
    await ctx.tool.transform(editor => editor.update("subagent", definition => {
      const execute = definition.execute
      definition.execute = async (input, tool) => {
        const initial = await check(tool.sessionID, "captured-subagent")
        await trace("invocation", { parentID: tool.sessionID, callID: tool.id, messageID: tool.messageID, input, generation: initial.generation })
        const result = await execute(input, { ...tool, progress: async update => {
          tool.signal.throwIfAborted()
          const current = await check(tool.sessionID, "child-progress")
          if (current.gate && current.generation !== initial.generation) throw new Error("Generation superseded")
          if (typeof update.sessionID === "string") {
            const child = await ctx.session.get({ sessionID: update.sessionID })
            if (child.parentID !== tool.sessionID) throw new Error("Native child parent mismatch")
            const binding = { parentID: tool.sessionID, childID: child.id, callID: tool.id, messageID: tool.messageID, rootID: current.rootID, generation: current.generation ?? 0 }
            await trace("progress-before-binding", binding)
            if (current.fault === "before-binding") { await trace("fault-held", { ...binding, fault: current.fault }); await new Promise((resolve, reject) => tool.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }
            await ctx.storage.set(`binding/${tool.sessionID}/${tool.id}`, binding)
            await ctx.storage.set(`current/${child.id}`, binding)
            await trace("bound", binding)
            if (current.explicitEnvironment) {
              const seed = JSON.parse(await readFile(`${root}/admission-seed.json`, "utf8"))
              const response = await fetch(seed.url, { method: "POST", headers: { "content-type": "application/json", cookie: seed.cookie }, body: JSON.stringify(binding), signal: AbortSignal.any([tool.signal, AbortSignal.timeout(15_000)]) })
              if (!response.ok) throw new Error("Owned private environment admission denied")
              await check(tool.sessionID, "environment-settlement")
              await ctx.storage.set(`environment-ready/${child.id}`, { incarnation, generation: current.generation, callID: tool.id })
              await trace("environment-admitted", binding)
            }
            if (current.fault === "after-admission") { await trace("fault-held", { ...binding, fault: current.fault }); await new Promise((resolve, reject) => tool.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }
          }
          await tool.progress(update)
        } })
        await trace("native-result", { parentID: tool.sessionID, callID: tool.id, result })
        const current = await check(tool.sessionID, "result-settlement")
        if (current.fault === "after-result") await new Promise((resolve, reject) => tool.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
        return result
      }
    }))
    await ctx.rpc.register(RPC, {
      control: async input => {
        if (input.token !== token) throw new Error("Private control unauthorized")
        const session = await ctx.session.get({ sessionID: input.rootID })
        if (session.parentID) throw new Error("Control requires actual root")
        const previous = await ctx.storage.get(`policy/${input.rootID}`)
        if (previous?.state === "stopped" && input.state !== "stopped") throw new Error("Stop is terminal")
        const { token: _, ...next } = input
        const value = { ...previous, ...next, generation: (previous?.generation ?? 0) + 1 }
        await ctx.storage.set(`policy/${input.rootID}`, value); await trace("control", value)
        return value
      },
      inspect: async input => {
        if (input.token !== token) throw new Error("Private inspect unauthorized")
        return { policies: (await ctx.storage.scan({ prefix: "policy/", limit: 100 })).entries, bindings: (await ctx.storage.scan({ prefix: "binding/", limit: 100 })).entries, signalListeners: { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }, appKeys: Object.keys(ctx.app) }
      },
      gracefulHandler: async input => {
        if (input.token !== token) throw new Error("Private graceful-handler unauthorized")
        const counts = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }
        const signal = counts.SIGTERM ? "SIGTERM" : counts.SIGINT ? "SIGINT" : null
        await trace("graceful-handler-request", { counts, signal })
        // Invoke only an already registered native shutdown handler. This is not
        // an OS signal, a service command, or an invented native shutdown API.
        if (signal) setTimeout(() => process.emit(signal), 100)
        return { attempted: Boolean(signal), counts, signal }
      },
    })
    return async () => { await trace("plugin-disposed", { incarnation }) }
  } }
}
