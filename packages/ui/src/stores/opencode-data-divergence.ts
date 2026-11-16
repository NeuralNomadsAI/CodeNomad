import type { OpenCodeEvent } from "@opencode/client"
import type { Data } from "@opencode/client/solid"
import { holdsEventTarget } from "./opencode-data-fragments"

/** Repair reads one reducer may owe its watched session per execution; the
 * settlement read of a still-diverged transcript is owed beyond it. */
export const MAX_DIVERGENCE_REPAIRS = 3

/** One reducer's divergence: the targets live events missed while it lacked
 * them (keyed by message, part kind and tool ID or fragment ordinal;
 * `undefined` for a reducer failure), and its repair budget. A replaced
 * reducer or a new execution starts a new record. */
export type TranscriptDivergence = {
  entry: object
  targets: Map<string, OpenCodeEvent | undefined>
  repairs: number
  pending: boolean
  /** A settlement observed during a pending repair owes one more read. */
  settlementOwed: boolean
}

export function divergenceFor(holder: { divergence?: TranscriptDivergence }, entry: object): TranscriptDivergence {
  if (holder.divergence?.entry !== entry) {
    holder.divergence = { entry, targets: new Map(), repairs: 0, pending: false, settlementOwed: false }
  }
  return holder.divergence
}

export function isDiverged(holder: { divergence?: TranscriptDivergence }, entry: object): boolean {
  return holder.divergence?.entry === entry && holder.divergence.targets.size > 0
}

/** After an authoritative page reseeded the reducer: settle the targets it
 * now holds (and a reducer failure); the rest stay owed. */
export function settleHeldTargets(divergence: TranscriptDivergence | undefined, data: Data): void {
  if (!divergence) return
  for (const [key, event] of divergence.targets) {
    if (!event || holdsEventTarget(data, event)) divergence.targets.delete(key)
  }
}
