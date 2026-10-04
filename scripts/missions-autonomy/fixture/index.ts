import { setupMissionsPlugin } from "../../../packages/server/src/opencode/missions-plugin"

export default { id: "codenomad.missions", async setup(ctx: any) {
  const dispose = await setupMissionsPlugin(ctx)
  await ctx.session.hook("http.request", (event: any) => {
    event.request.headers.set("x-integration-session", event.sessionID)
    event.request.headers.set("x-integration-kind", event.kind)
  })
  // Deliberately model a native delegation capability that is not available.
  // No replacement tool, native receipt, qualified publisher or second store.
  await ctx.session.hook("context", (event: any) => {
    if (event.agent === "fallback_trial") delete event.tools.subagent
  })
  return dispose
} }
