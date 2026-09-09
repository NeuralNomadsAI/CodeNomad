import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { messageTargetSchema, pruneRequestSchema, pruningRpcDefinition } from "./contract"
import { previewContent } from "./planner"
import { readPruningPreview } from "./preview-store"

export const SessionPruningRpc = Rpc.define(pruningRpcDefinition)

// Explicit opt-in entry point; not auto-installed or imported by server startup.
export default Plugin.define({
  id: "codenomad-session-pruning",
  async setup(ctx) {
    const registration = await ctx.rpc.register(SessionPruningRpc, {
      preview: async (input) => {
        const target = messageTargetSchema.parse(input)
        const session = await ctx.session.get({ sessionID: target.sessionID })
        // Location membership must be checked again inside the plugin: clients
        // other than CodeNomad may invoke this RPC directly.
        if (session.location.directory !== ctx.location.directory) return { status: "blocked", reason: "not_deletable" } as const
        // Plugin Context does not expose session.message in beta-19398. Read
        // the explicit DB in query-only mode, including pre-compaction history.
        const data = await readPruningPreview(ctx.options.databasePath, target, session.location.directory)
        return data ? previewContent(data) : { status: "blocked", reason: "unavailable" } as const
      },
      prune: async (input) => {
        pruneRequestSchema.parse(input)
        // No idle check / plugin-local mutex can prevent a TUI prompt racing
        // this mutation. Do not expose a config switch bypassing this gate.
        return { status: "blocked", reason: "maintenance_required" } as const
      },
    })
    return () => registration.dispose()
  },
})
