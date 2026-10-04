import type { Plugin } from "@opencode/plugin"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createNativeMissionObserver } from "../../../packages/server/src/missions/native-subsession-experiment/observer"
import { readNativeMissionFamily } from "../../../packages/server/src/missions/native-session-family"
import { MissionJournal } from "../../../packages/server/src/missions/journal"

export default {
  id: "native.observer.spike",
  async setup(ctx: Plugin.Context) {
    if ("workspaceID" in ctx.location && ctx.location.workspaceID) throw new Error("DENY: experiment is owned local Location only")
    let rawReader: ((id: string) => Promise<SessionMessageInfo[]>) | undefined
    let familyReader: ((root: SessionInfo) => Promise<boolean>) | undefined
    const make = () => createNativeMissionObserver(ctx.storage, {
      session: id => ctx.session.get({ sessionID: id }),
      messages: id => rawReader ? rawReader(id) : ctx.session.context({ sessionID: id }),
      idleFamily: root => familyReader ? familyReader(root) : Promise.resolve(false),
    }, ctx.location.project.id, ctx.location.directory)
    let observer = make()
    const generation = Number(await ctx.storage.get("generation") ?? 0) + 1
    await ctx.storage.set("generation", generation)
    await ctx.session.hook("http.request", event => {
      event.request.headers.set("x-observer-session", event.sessionID)
      event.request.headers.set("x-observer-kind", event.kind)
    })
    await ctx.session.hook("retry", event => { event.decision = { retry: false } })
    const observations: unknown[] = []
    let contextHook = await hook()
    let eventAbort = subscribe()
    function subscribe() {
      const abort = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type === "session.tool.progress") await observer.observe(event)
        }
      })().catch(error => { if (!abort.signal.aborted) observations.push({ observerError: String(error) }) })
      return abort
    }
    async function hook() {
      return ctx.session.hook("context", async event => {
        let observation
        try { observation = await observer.context(event.sessionID) }
        catch (error) { observation = { status: "unknown", sourceID: event.sessionID, reason: String(error) } }
        observations.push({ generation, time: Date.now(), observation })
        event.system.push({ type: "text", text: "OBSERVER_CONTEXT:" + JSON.stringify(observation) })
      })
    }
    // Add a business report tool; never update native subagent/tools/schema/options.
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "observer", description: "Private attach-only business bookkeeping" })
      editor.add({ name: "report", description: "Coordinator confirms terminal, task-matched native evidence",
        input: { type: "object", additionalProperties: false, properties: {
          missionID: { type: "string" }, taskKey: { type: "string" }, rootID: { type: "string" }, sourceID: { type: "string" },
          revision: { type: "integer" }, evidenceToolID: { type: "string" }, summary: { type: "string" }, reportID: { type: "string" },
        }, required: ["missionID", "taskKey", "rootID", "sourceID", "revision", "evidenceToolID", "summary", "reportID"] },
        options: { namespace: "observer", codemode: false }, execute: async (input, tool) => ({ content: JSON.stringify(
          await observer.report(tool.sessionID, input as Parameters<typeof observer.report>[1])) }) })
    })
    // Read-only supported hook captures native admission/result identity without
    // executing anything or modifying input/result/options.
    const nativeHooks: unknown[] = []
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "subagent") return
      try {
        const parentContext = await observer.context(event.sessionID)
        const invocation = { phase: "before", ...event, parentContext }
        nativeHooks.push(invocation)
        await ctx.storage.set("native-invocation/" + event.id, JSON.parse(JSON.stringify(invocation)))
      } catch (error) { nativeHooks.push({ phase: "before", toolID: event.id, observerError: String(error) }) }
    })
    await ctx.tool.hook("execute.after", event => { if (event.tool === "subagent") nativeHooks.push({ phase: "after", ...event }) })
    await ctx.rpc.register({ id: "native.observer.spike", methods: { control: { input: { type: "object" }, output: { type: "object" } } }, events: {} }, {
      control: async raw => JSON.parse(JSON.stringify(await dispatch(raw))),
    })
    async function dispatch(raw: unknown) {
        const input = raw as Record<string, any>
        try {
          if (input.action === "reader") {
            const url = new URL(input.url)
            if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.username || url.password) throw new Error("DENY: private loopback reader only")
            const headers = { authorization: "Basic " + btoa("opencode:" + input.password) }
            const infoResponse = await fetch(new URL("/api/info", url), { headers, signal: AbortSignal.timeout(5000) })
            if (!infoResponse.ok) throw new Error("DENY: reader authentication")
            const info = await infoResponse.json() as { pid: number; version: string }
            if (info.pid !== input.pid || info.version !== "2.0.22") throw new Error("DENY: wrong private native runtime")
            rawReader = async id => {
              const response = await fetch(new URL(`/api/session/${encodeURIComponent(id)}/message?limit=100&order=asc`, url), { headers, signal: AbortSignal.timeout(5000) })
              if (!response.ok) throw new Error("UNKNOWN: native raw message read")
              const page = await response.json() as { data: SessionMessageInfo[]; cursor: { next?: string } }
              if (!Array.isArray(page.data) || page.data.length >= 100) throw new Error("UNKNOWN: bounded raw message page")
              return page.data
            }
            familyReader = async root => {
              const activeResponse = await fetch(new URL("/api/session/active", url), { headers, signal: AbortSignal.timeout(5000) })
              if (!activeResponse.ok) throw new Error("UNKNOWN: native activity unavailable")
              const { data: active } = await activeResponse.json() as { data: Record<string, unknown> }
              if (!active || typeof active !== "object") throw new Error("UNKNOWN: native activity shape")
              // Real authenticated HTTP adapter for the existing bounded family
              // reader. Its only exercised method is session.list (not a fake).
              const adapter = { session: { list: async (input: { parentID?: string; limit?: number; cursor?: string }) => {
                const endpoint = new URL("/api/session", url)
                for (const [key, value] of Object.entries(input)) if (value !== undefined) endpoint.searchParams.set(key, String(value))
                const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(5000) })
                if (!response.ok) throw new Error("UNKNOWN: native family read")
                return response.json()
              } } } as Parameters<typeof readNativeMissionFamily>[0]
              const family = await readNativeMissionFamily(adapter, root, AbortSignal.timeout(10_000))
              const recheckedResponse = await fetch(new URL("/api/session/active", url), { headers, signal: AbortSignal.timeout(5000) })
              if (!recheckedResponse.ok) throw new Error("UNKNOWN: native activity unavailable")
              const { data: rechecked } = await recheckedResponse.json() as { data: Record<string, unknown> }
              if (!rechecked || typeof rechecked !== "object") throw new Error("UNKNOWN: native activity shape")
              return [...family].every(id => !active[id] && !rechecked[id])
            }
            return { attached: "authenticated-native-raw-reader", pid: info.pid }
          }
          if (input.action === "intent") return { value: await observer.intent(input.caller, input.missionID, input.objective, input.tasks) }
          if (input.action === "attach") return { value: await observer.attach(input.caller, input.missionID, input.taskKey, input.rootID, input.revision) }
          if (input.action === "context") return { value: await observer.context(input.sessionID) }
          if (input.action === "watch") return { value: await observer.watch(input.ids) }
          if (input.action === "snapshot") return { value: await observer.snapshot() }
          if (input.action === "revise-source") {
            const map = (await observer.snapshot()).missions.find(m => m.id === input.missionID)
            const caller = await ctx.session.get({ sessionID: input.caller })
            if (!map || map.coordinatorSessionId !== caller.id || caller.projectID !== ctx.location.project.id
              || caller.location.directory !== ctx.location.directory || map.revision !== input.revision) throw new Error("DENY: fixture coordinator/source revision")
            const journal = new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.directory)
            await journal.append({ version: 1, projectID: ctx.location.project.id, missionID: map.id, id: "fixture_source_revision", createdAt: Date.now(),
              type: "mission.revised", requestID: "fixture_source_revision", expectedRevision: map.revision, actorSessionID: caller.id,
              reason: "Private explicit source-change guard", notesSpecified: false, retiredTasks: [], addedTasks: [],
              dependencyUpdates: [{ taskKey: "task-a", blockedBy: ["task-b"] }] })
            return { value: await observer.snapshot() }
          }
          if (input.action === "capture") return JSON.parse(JSON.stringify({ generation, reader: rawReader ? "external-raw" : "inprocess-context", observations, nativeHooks,
            catalog: (await ctx.tool.list()).map(t => ({ id: t.id, input: t.input, options: t.options })),
            storage: await ctx.storage.scan({ prefix: "", limit: 100 }) }))
          if (input.action === "dispose") { eventAbort.abort(); await contextHook.dispose(); return { disposed: true } }
          if (input.action === "rebuild") { observer = make(); contextHook = await hook(); eventAbort = subscribe(); return { rebuilt: true, value: await observer.snapshot() } }
          throw new Error("Unknown fixture action")
        } catch (error) { return { error: String(error) } }
    }
    return () => eventAbort.abort()
  },
}
