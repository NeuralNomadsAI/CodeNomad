import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import type { Data } from "@opencode/client/solid"
import type { TranscriptEntry } from "./opencode-data"

/** A shared-stream reconnect reconciles this long after the last native event. */
const RECONNECT_RESYNC_DELAY_MS = 1000

/** The live state one session carries across a verified same-source reset. */
export interface ReconnectCapture {
  sessionId: string
  directory: string
  messages: SessionMessageInfo[]
  retireWhenDrained: boolean
  onResynced?: (data: Data) => void
}

/** Transcript operations the reconnect path needs from its host. Keeping them
 * explicit lets this module own reconnect state without importing the store. */
export interface ReconnectHost {
  /** Capture the live sessions of an instance before its projections reset. */
  capture(instanceId: string): ReconnectCapture[]
  /** Full instance reset: generation fences, observer rebinding, REST state. */
  resetInstance(instanceId: string): void
  /** Recreate a transcript entry carrying the captured publication and
   * retirement state; the host seeds its page separately. */
  recreateTranscript(instanceId: string, capture: ReconnectCapture): TranscriptEntry
  /** Seed the recreated entry with the captured page. */
  seedPage(instanceId: string, capture: ReconnectCapture): Promise<unknown>
  /** Dropping-mode recovery, used when seeding fails. */
  scheduleDroppingResync(instanceId: string, sessionId: string, transcript: TranscriptEntry): void
  isCurrent(instanceId: string, sessionId: string, transcript: TranscriptEntry): boolean
  fullDataRevision(instanceId: string, sessionId: string): number
  clearRetryTimer(transcript: TranscriptEntry): void
  resyncAuthoritative(instanceId: string, sessionId: string, transcript: TranscriptEntry): Promise<void>
}

/** Reconnect continuity for native transcripts. A shared-stream reconnect is
 * transport recovery, not a data reset: live events keep admitting on a
 * reducer seeded with the last projected page, while one quiet,
 * revision-stable snapshot reconciles what the disconnect window missed. */
export function createReconnect(host: ReconnectHost) {
  /** Last observed daemon identity per instance; continuity is seeded only
   * when the reconnect is verified to come from the same source. */
  const daemonSources = new Map<string, string>()

  /** One quiet, revision-stable reconnect reconciliation: live events keep
   * admitting on the resident entry, so the fetch only starts after the stream
   * stays quiet for the delay and never drops anything. */
  function scheduleTrailing(instanceId: string, sessionId: string, transcript: TranscriptEntry): void {
    if (!host.isCurrent(instanceId, sessionId, transcript)
      || transcript.needsAuthoritativeResync || transcript.resyncing || !transcript.reconnectResync) return
    host.clearRetryTimer(transcript)
    const revision = host.fullDataRevision(instanceId, sessionId)
    transcript.retryTimer = setTimeout(() => {
      transcript.retryTimer = undefined
      if (!host.isCurrent(instanceId, sessionId, transcript) || !transcript.reconnectResync) return
      if (host.fullDataRevision(instanceId, sessionId) !== revision) {
        // Events kept arriving: trail behind the live stream instead of racing it.
        scheduleTrailing(instanceId, sessionId, transcript)
        return
      }
      void host.resyncAuthoritative(instanceId, sessionId, transcript)
    }, RECONNECT_RESYNC_DELAY_MS)
  }

  function reconnect(instanceId: string): void {
    const live = host.capture(instanceId)
    host.resetInstance(instanceId)
    for (const capture of live) {
      const transcript = host.recreateTranscript(instanceId, capture)
      // Arm the trailing timer before seeding: while it is pending, deferred
      // retirement cannot fire on a transcript whose page has not landed yet.
      scheduleTrailing(instanceId, capture.sessionId, transcript)
      void host.seedPage(instanceId, capture).catch(() => {
        // Seeding failed: fall back to dropping-mode recovery so the transcript
        // still reconciles from one quiet authoritative snapshot.
        transcript.reconnectResync = false
        host.scheduleDroppingResync(instanceId, capture.sessionId, transcript)
      })
    }
  }

  return {
    scheduleTrailing,
    forgetInstance(instanceId: string): void {
      daemonSources.delete(instanceId)
    },
    onServerConnected(instanceId: string, event: OpenCodeEvent): void {
      const daemon = (event as { data?: { daemon?: unknown } }).data?.daemon
      const source = typeof daemon === "string" && daemon.length > 0 ? daemon : undefined
      // Seed continuity only across a verified same-daemon reconnect; a
      // replaced daemon and an unattributed stream keep the hard reset.
      if (source !== undefined && daemonSources.get(instanceId) === source) reconnect(instanceId)
      else host.resetInstance(instanceId)
      if (source !== undefined) daemonSources.set(instanceId, source)
    },
  }
}
