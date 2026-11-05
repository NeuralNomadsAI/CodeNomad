import type { z } from "zod"
import type { OpenCodeServerProfileSchema, ProjectExecutionBindingSchema } from "../../config/schema"

export const LOCAL_SHARED_SERVER_ID = "local-shared" as const
export type OpenCodeServerId = string
export type OpenCodeServerProfile = z.infer<typeof OpenCodeServerProfileSchema>
export type ProjectExecutionBinding = z.infer<typeof ProjectExecutionBindingSchema>
export type OpenCodeServerSummary =
  | { kind: "local-shared"; id: typeof LOCAL_SHARED_SERVER_ID }
  | { kind: "explicit"; id: OpenCodeServerId; label: string; origin: string;
      hasCredentials: boolean; needsCredentials: boolean }

export const SERVER_CONNECTION_LIMITS = Object.freeze({
  explicitActiveTargets: 4, reservedLocalTargets: 1,
  administrativeProbes: 1, probeTimeoutMs: 5_000, probeMaxBytes: 8 * 1024 * 1024,
  secondaryBrowserReads: 2, eventJobs: 2_048, eventBytes: 32 * 1024 * 1024,
  eventJobTimeoutMs: 60_000, reservedLocalEventJobs: 256, reservedLocalEventBytes: 4 * 1024 * 1024,
})

/** Connection-engine contract; durable bindings contain only serverId + directory.
 * Reserve atomically per target, sharing admission/SSE across projects and windows.
 * Failed initial admission releases its reservation; admitted offline/rotating targets retain it.
 * Restore in existing queue order; excess targets remain reconnectable (quota), without eviction.
 * Last project occurrence closing across windows releases the slot and cancels reads/SSE/retry.
 * Connect without projects retains a slot until Disconnect/shutdown or an attach/last-close cycle.
 * Disconnect cancels/fences/releases, preserving tabs/drafts; only explicit Connect resumes them.
 * Connect/Disconnect are host-only, preserve native sessions and never stop OpenCode.
 * Their intent stays in memory; opportunistic tab reads never reconnect a disconnected target.
 * Administrative probes use their separate bounded lane, without slots, SSE or retries;
 * form close or URL/auth changes cancel them. Paired clients use already admitted projects.
 * Event admission reserves the local share, divides the remainder fairly among explicit
 * sources, and signals bounded resync/diagnostics on saturation.
 */
export type ServerConnectionGeneration = number
