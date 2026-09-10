import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { messageTargetSchema, pruneRequestSchema, pruningRpcDefinition } from "./contract"
import { previewContent } from "./planner"
import { readPruningPreview } from "./preview-store"
import { pruneBoundMessage } from "./service"
import { pruningDatabasePath } from "./database-path"

export const SessionPruningRpc = Rpc.define(pruningRpcDefinition)

// Native local-plugin entry point. Only a user's pruning RPC changes content.
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
        const data = await readPruningPreview(pruningDatabasePath(ctx.options.databasePath, ctx.app.channel), target, session.location.directory)
        const preview = data ? previewContent(data) : { status: "blocked", reason: "unavailable" } as const
        return preview.status === "preview"
          ? { ...preview, liveMutation: true }
          : preview
      },
      prune: async (input, call) => {
        pruneRequestSchema.parse(input)
        const result = await pruneBoundMessage(ctx, input, call.signal)
        if (result.status === "pruned") {
          // Retrying the same input returns its atomic receipt and re-emits the
          // notification. An emission failure cannot undo a committed write.
          await registration.events.emit("pruned", {
            sessionID: input.sessionID, messageID: input.messageID, revision: result.revision,
          }).catch(() => {})
        }
        return result
      },
    })
    return () => registration.dispose()
  },
})
