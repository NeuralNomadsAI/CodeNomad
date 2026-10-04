import { start, read, report } from "../../../packages/server/src/missions/native-subsession-experiment/integration.ts"
import { MissionJournal } from "../../../packages/server/src/missions/journal.ts"

export default { id: "native-mission.integration.experiment", async setup(ctx: any) {
  const traces: unknown[] = [], abort = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      if (event.location?.directory !== ctx.location.directory) continue
      if (event.type === "session.inbox.enqueued" && event.data.item?.type === "user") await ctx.storage.set("integration-admission/" + event.data.sessionID,
        { id: event.data.inboxID, delivery: event.data.item.delivery, createdAt: event.created, eventID: event.id })
      if (event.type !== "session.tool.progress" || typeof event.data.metadata?.sessionID !== "string") continue
      const childID = event.data.metadata.sessionID, child = await ctx.session.get({ sessionID: childID })
      if (child.parentID !== event.data.sessionID || child.projectID !== ctx.location.project.id || child.location.directory !== ctx.location.directory) continue
      await ctx.storage.set("integration-call/" + childID + "/" + event.data.id, { childID, parentID: child.parentID, callID: event.data.id, eventID: event.id })
    }
  })().catch(error => { if (!abort.signal.aborted) traces.push({ observerError: String(error) }) })
  await ctx.session.hook("http.request", (event: any) => {
    event.request.headers.set("x-integration-session", event.sessionID)
    event.request.headers.set("x-integration-kind", event.kind)
  })
  await ctx.session.hook("retry", (event: any) => { event.decision = { retry: false } })
  await ctx.session.hook("context", async (event: any) => {
    const binding = await read(ctx, event.sessionID)
    traces.push({ sessionID: event.sessionID, time: Date.now(), binding })
    if (binding) event.system.push({ type: "text", text: "INTEGRATION_CONTRACT:" + JSON.stringify({ missionID: binding.missionID, coordinatorID: binding.coordinatorID,
      lineage: binding.lineage, tasks: binding.mission.tasks.map(task => ({ key: task.key, status: task.status, blockedBy: task.blockedBy })), authority: "root-wide inherited report scope; not a per-task execution gate" }) })
  })
  await ctx.tool.transform((editor: any) => {
    editor.namespace({ name: "integration", description: "Private provisional Mission integration" })
    editor.add({ name: "start", description: "Create the research three-task business contract without dispatching work",
      input: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"], additionalProperties: false },
      options: { namespace: "integration", codemode: false }, execute: async (input: any, tool: any) => ({ content: JSON.stringify(await start(ctx, tool.sessionID, input.objective)) }) })
    editor.add({ name: "report", description: "Explicit descendant task evidence or explicit coordinator final report",
      input: { type: "object", properties: { final: { type: "boolean" }, taskKey: { type: "string" }, outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
        summary: { type: "string" }, evidence: { type: "array", items: { type: "string" }, maxItems: 12 } }, required: ["outcome", "summary"], additionalProperties: false },
      options: { namespace: "integration", codemode: false }, execute: async (input: any, tool: any) => {
        traces.push({ reportInvocation: { sessionID: tool.sessionID, callID: tool.id, final: Boolean(input.final), time: Date.now() } })
        return { content: JSON.stringify(await report(ctx, tool, input)) }
      } })
  })
  await ctx.rpc.register({ id: "native.integration.fixture", methods: { inspect: { input: { type: "object" }, output: { type: "object" } } }, events: {} }, {
    inspect: async () => JSON.parse(JSON.stringify({ snapshot: await new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical).snapshot(), traces,
      tools: (await ctx.tool.list()).map((tool: any) => ({ id: tool.id, input: tool.input, options: tool.options })) })),
  })
  return () => abort.abort()
} }
