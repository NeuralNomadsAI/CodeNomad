import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { messageTargetSchema, pruneRequestSchema, pruningRpcDefinition } from "./contract"
import { previewContent } from "./planner"
import { readPruningPreview } from "./preview-store"
import { pruneBoundMessage } from "./service"
import { pruningDatabasePath } from "./database-path"
import { readLocationRef, sameLocation } from "./location"
import { historyQuerySchema, historyNativeResultSchema, pruneBatchSchema, pruneBatchResultSchema } from "./history-contract"
import { queryBoundHistory, pruneBoundBatch } from "./history-service"
import { navigationWindowInputSchema, navigationWindowResultSchema, outlineInputSchema, outlineResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema } from "./navigation-contract"
import { readOutlinePreviews } from "./outline-preview"
import { readNavigationWindow, readSessionOutline } from "./navigation-store"
import { withHistoryDatabase } from "./history-database"

export const SessionPruningRpc = Rpc.define({ ...pruningRpcDefinition, methods: {
  ...pruningRpcDefinition.methods,
  history: { input: historyQuerySchema, output: historyNativeResultSchema },
  pruneBatch: { input: pruneBatchSchema, output: pruneBatchResultSchema },
  window: { input: navigationWindowInputSchema, output: navigationWindowResultSchema },
  outline: { input: outlineInputSchema, output: outlineResultSchema },
  outlinePreview: { input: outlinePreviewInputSchema, output: outlinePreviewResultSchema },
} })

// Native local-plugin entry point. Only a user's pruning RPC changes content.
export default Plugin.define({
  id: "codenomad-session-pruning",
  async setup(ctx) {
    const registration = await ctx.rpc.register(SessionPruningRpc, {
      window: (input, call) => withHistoryDatabase(ctx, input.sessionID, call.signal,
        (db, scope) => readNavigationWindow(db, scope, input.target, call.signal)),
      outline: (input, call) => withHistoryDatabase(ctx, input.sessionID, call.signal,
        (db, scope) => readSessionOutline(db, scope, input.cursor, call.signal, input.after, input.known)),
      outlinePreview: (input, call) => withHistoryDatabase(ctx, input.sessionID, call.signal,
        (db, scope) => readOutlinePreviews(db, scope, input.messageIDs, call.signal)),
      history: (input, call) => queryBoundHistory(ctx, input, call.signal),
      pruneBatch: (input, call) => pruneBoundBatch(ctx, input, call.signal, async (sessionID, result) => {
        await registration.events.emit("pruned", { sessionID, messageID: result.messageID, revision: result.revision })
      }),
      preview: async (input) => {
        const target = messageTargetSchema.parse(input)
        const session = await ctx.session.get({ sessionID: target.sessionID })
        // Location membership must be checked again inside the plugin: clients
        // other than CodeNomad may invoke this RPC directly.
        const location = readLocationRef(session.location)
        if (!sameLocation(location, readLocationRef(ctx.location)) || session.projectID !== ctx.location.project.id) {
          return { status: "blocked", reason: "not_deletable" } as const
        }
        // Plugin Context does not expose session.message in beta-19398. Read
        // the explicit DB in query-only mode, including pre-compaction history.
        const data = await readPruningPreview(pruningDatabasePath(ctx.options.databasePath, ctx.app.channel), target, location, session.projectID)
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
