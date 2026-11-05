import { readFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"

// A synchronous admission boundary, not an asynchronous session.created listener.
export default Plugin.define({
  id: "codenomad.memory-proof",
  async setup(ctx) {
    await ctx.session.hook("title", event => { event.result = "Memory proof" })
    await ctx.session.hook("prompt", async event => {
      const state = JSON.parse(await readFile(ctx.options.state, "utf8"))
      if (!state.enabled) return
      if (state.fail) throw new Error("MEMORY_PROOF_ADMISSION_UNAVAILABLE")
      // Stand in for the authenticated CodeNomad bridge returning fresh titles.
      await ctx.session.instructions.entry.put({ sessionID: event.sessionID, key: "codenomad.memory", value: {
        rule: "NATIVE_MEMORY_CANARY", revision: state.revision, owner: event.sessionID, titles: ["A title only"],
      } })
    })
  },
})
