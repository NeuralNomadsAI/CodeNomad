import { start, record, report } from "./mission.ts"
import { MissionJournal } from "../../../packages/server/src/missions/journal.ts"

export default { id: "native-first.experiment", async setup(ctx: any) {
  const traces: any[] = []
  const eventAbort = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
      if (event.type === "session.inbox.enqueued" && event.location?.directory === ctx.location.directory && event.data.item?.type === "user") {
        await ctx.storage.set("native-first-admission/" + event.data.sessionID,
          { id: event.data.inboxID, delivery: event.data.item.delivery, createdAt: event.created, eventID: event.id })
      }
      if (event.type !== "session.tool.progress" || event.location?.directory !== ctx.location.directory || typeof event.data?.metadata?.sessionID !== "string") continue
      const childID = event.data.metadata.sessionID
      const child = await ctx.session.get({ sessionID: childID })
      if (child.parentID !== event.data.sessionID || child.projectID !== ctx.location.project.id || child.location.directory !== ctx.location.directory) continue
      await ctx.storage.set("native-first-call/" + childID + "/" + event.data.id,
        { childID, parentID: child.parentID, callID: event.data.id, eventID: event.id, time: Date.now() })
    }
  })().catch(error => { if (!eventAbort.signal.aborted) traces.push({ observerError: String(error) }) })
  await ctx.session.hook("http.request", (event: any) => {
    event.request.headers.set("x-first-session", event.sessionID)
    event.request.headers.set("x-first-kind", event.kind)
  })
  await ctx.session.hook("retry", (event: any) => { event.decision = { retry: false } })
  await ctx.session.hook("context", async (event: any) => {
    const binding = await record(ctx, event.sessionID)
    traces.push({ sessionID: event.sessionID, time: Date.now(), binding })
    if (binding) event.system.push({ type: "text", text: "NATIVE_FIRST_CONTRACT:" + JSON.stringify(binding) })
  })
  await ctx.tool.transform((editor: any) => {
    editor.namespace({ name: "first", description: "Private native-first mission contract" })
    editor.add({ name: "start", description: "Register an owned root contract; does not execute work",
      input: { type: "object", properties: { objective: { type: "string" }, tasks: { type: "array", items: { type: "string" } } }, required: ["objective", "tasks"], additionalProperties: false },
      options: { namespace: "first", codemode: false }, execute: async (input: any, tool: any) => ({ content: JSON.stringify(await start(ctx, tool.sessionID, input)) }) })
    editor.add({ name: "report", description: "Report explicit business evidence for an inherited root task",
      input: { type: "object", properties: { taskKey: { type: "string" }, outcome: { type: "string", enum: ["completed", "blocked", "failed"] }, summary: { type: "string" } }, required: ["taskKey", "outcome", "summary"], additionalProperties: false },
      options: { namespace: "first", codemode: false }, execute: async (input: any, tool: any) => ({ content: JSON.stringify(await report(ctx, tool, input)) }) })
  })
  await ctx.rpc.register({ id: "native.first.fixture", methods: { inspect: { input: { type: "object" }, output: { type: "object" } } }, events: {} }, {
    inspect: async () => {
      const tools = await ctx.tool.list()
      return JSON.parse(JSON.stringify({ snapshot: await new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical).snapshot(), traces,
        nativeDefinitionPolicy: "No native tool edits; only first_start and first_report additions",
        tools: tools.map((t: any) => ({ id: t.id, input: t.input, options: t.options })) }))
    },
  })
  return () => eventAbort.abort()
} }
