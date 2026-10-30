import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import type { MissionDocument } from "../../missions/mission-document"
import { matchesExecution } from "../../missions/execution"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import { NativeScheduleCalendarOwner } from "./native-schedule-owner"
import { nativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"
import { assertNativeScheduleProviderAvailable } from "./native-schedule-provider-registration"
import type { NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { acquireMissionNativeService, type MissionNativeRunner } from "./native-service-adapter"
import type { AutonomousProfileSource } from "./autonomous-environment"
import { acquireNativeMissionConditionReader, assertMissionSourceAcyclic } from "./native-mission-condition-reader"
import { prepareNativeDocumentSources } from "./native-scheduled-passage-sources"
import { acquireNativeSourceFence } from "./native-source-fence"
import { prepareMissionPassageText, recordMissionPassageText } from "../../missions/mission-passage-text"
import type { MissionStorage } from "../../missions/journal"

/** Shared acquisition for authenticated controls and technical reconciliation.
 * Native services and their guards live only in this receiving RPC graph. */
export const acquireNativeMissionScheduleOwner = Effect.fn("missions.acquireScheduleOwner")(function* (
  ctx: Plugin.Context, document: MissionDocument, run: MissionNativeRunner, current: () => true,
  installation = document.calendarOwner?.installation, profileSource = document.calendarOwner?.profileSource,
) {
  if (!installation || !profileSource) throw new Error("Mission schedule owner unavailable")
  const selectedInstallation: NativeScheduleCarrierInstallation = installation
  const selectedProfile: AutonomousProfileSource = profileSource
  const agents = yield* ctx.agent.list()
  const configured = document.configuration.profiles?.coordinator?.agent
  const carrier = agents.data.find(agent => agent.id === configured && agent.mode !== "subagent")
    ?? agents.data.find(agent => !agent.hidden && agent.mode !== "subagent")
  if (!carrier) throw new Error("Mission schedule carrier agent unavailable")
  const store = yield* acquireNativeMissionDocumentStore(ctx, run)
  const native = yield* acquireNativeScheduleCalendarService(ctx, carrier.id, current, run,
    () => assertNativeScheduleProviderAvailable(ctx, selectedInstallation))
  const service = yield* acquireMissionNativeService(current, run)
  const fence = yield* acquireNativeSourceFence(current)
  const signal = new AbortController().signal
  const reader = yield* acquireNativeMissionConditionReader(ctx, store, run, signal, current)
  const textStorage = (guard: () => true): MissionStorage => ({ get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
    set: async (key, value, supplied) => { guard(); supplied?.(); await run(ctx.storage.set(key, value)); guard() } })
  const textGuard = (locked: typeof store, doc: MissionDocument) => (): true => {
    locked.assertActive(); current(); return assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
  }
  const owner = new NativeScheduleCalendarOwner({ store, native, bindings: nativeScheduleOwnerBindings(ctx, run),
    installation: selectedInstallation, profileSource: selectedProfile, current,
    prepareTextEdit: (locked, doc, configuration) => {
      const guard = textGuard(locked, doc)
      return prepareMissionPassageText(textStorage(guard), doc, configuration, guard)
    },
    recordTextEdit: (locked, doc, publish) => {
      const guard = textGuard(locked, doc)
      return recordMissionPassageText(textStorage(guard), doc, guard, publish)
    },
    sources: async (doc, locked) => {
      locked.assertActive(); current()
      await assertMissionSourceAcyclic(doc, locked)
      return prepareNativeDocumentSources(doc, service, signal, current, reader, fence())
    },
    resumePending: async (locked, doc) => {
      const pending = doc.pending, owner = doc.calendarOwner
      if (!pending || pending.admittedAt === null || !owner || doc.blocked === "unknown") return undefined
      const guard = (): true => { locked.assertActive(); current(); return assertMissionCalendarPlacement(owner.placement, doc.configuration.roots) }
      guard()
      const session = await service.get({ sessionID: pending.coordinatorSessionID })
      const selected = pending.configuration.profiles?.coordinator
      if (!selected || !matchesExecution(selected, session) || session.parentID || session.projectID !== doc.projectID
        || session.location.directory !== ctx.location.directory || session.location.workspaceID !== ctx.location.workspaceID)
        return undefined
      const original = documentPassageStartInput(doc)
      const message = await service.message({ sessionID: pending.coordinatorSessionID, messageID: pending.messageID })
      const queued = (await service.inbox(pending.coordinatorSessionID)).find(item => item.id === pending.messageID)
      const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
      const present = message?.type === "synthetic" && message.text === original.text && same(message.metadata, original.metadata)
        || queued?.type === "synthetic" && queued.sessionID === pending.coordinatorSessionID && queued.delivery === original.delivery
          && same(queued.payload, { text: original.text, description: original.description, metadata: original.metadata })
      guard()
      if (!present) return undefined
      return { passageID: pending.id, messageID: pending.messageID, coordinatorSessionID: pending.coordinatorSessionID, current: guard }
    },
  })
  return { owner, native, store }
})
