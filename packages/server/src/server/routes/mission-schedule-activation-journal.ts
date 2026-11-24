import type { OpenCodeClient } from "@opencode/client"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionDocumentSummary } from "../../missions/mission-document-one-time"
import type { NativeScheduleActivationJournal } from "../../opencode/native-schedule-settings-activation"

const missions = (client: OpenCodeClient) => client.rpc(CODENOMAD_MISSIONS_RPC)
type Rpc = Pick<ReturnType<typeof missions>, "documentActivation">

/** The authenticated route owns connection/Location/deletion admission throughout
 * the executor. Each phase rechecks that same acquired authority; this adapter
 * persists only exact request/digest metadata and never arms native calendars. */
export function missionScheduleActivationJournal(rpc: Rpc, options: Parameters<Rpc["documentActivation"]>[1],
  identity: { missionID: string; requestID: string; expectedRevision: number }, current: () => void) {
  type Phase = Omit<Parameters<Rpc["documentActivation"]>[0], keyof typeof identity>
  const send = async (phase: Phase): Promise<MissionDocumentSummary> => {
    current()
    const result = await rpc.documentActivation({ ...identity, ...phase }, options) as { document: MissionDocumentSummary }
    current()
    return result.document
  }
  const journal: NativeScheduleActivationJournal = {
    prepared: async plan => { await send({ action: "prepare", authority: plan.authority,
      targets: plan.targets.map(target => ({ ...target, attempted: false, acknowledged: false })) }) },
    attempting: async (scope, resultDigest) => { await send({ action: "attempting", scope, resultDigest }) },
    acknowledged: async (scope, resultDigest) => { await send({ action: "acknowledged", scope, resultDigest }) },
    ready: async effectiveOrigin => { await send({ action: "ready", effectiveOrigin }) },
  }
  return { journal, read: () => send({ action: "read" }), failed: (errorCode: string) => send({ action: "failed", errorCode }) }
}
