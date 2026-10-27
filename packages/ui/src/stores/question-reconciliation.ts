import { resolveFormToolTarget } from "../components/form-request-tool-target"
import { getLogger } from "../lib/logger"
import { getFormQueue, type FormWithLocation } from "./forms"
import { syncPendingRequests } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { sessions } from "./session-state"

/** Where a targeted pending-request sync should be sent. */
export interface ReconciliationLocation {
  directory: string
  workspaceID?: string
}

/** The armed transcript part an episode is trying to recover a dock entry for. */
interface ArmedPart {
  instanceId: string
  sessionId: string
  messageId: string
  partId: string
}

interface Episode {
  part: ArmedPart
  armed: boolean
  attempts: number
  timer?: ReturnType<typeof setTimeout>
}

export interface QuestionReconciliationDeps {
  /** Joins the coalesced loaded-only pending-request recovery for an instance. */
  schedule: (instanceId: string, location?: ReconciliationLocation) => void
  /** Dock state for the instance; consulted at evaluation time, never at arm time. */
  getForms: (instanceId: string) => FormWithLocation[]
  /** Whether a docked form is the visible form of the armed message part. */
  matchesForm: (form: FormWithLocation, messageId: string, partId: string) => boolean
  /** Accepted for the injected-time seam; the schedule itself lives on the timers. */
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

const GRACE_MS = 2_000
const RETRY_MS = 6_000
const MAX_SYNCS_PER_EPISODE = 2

const log = getLogger("session")

/**
 * Recovers a lost dock entry: while a `question` tool part is visibly running in
 * the transcript but its form never reached the interruption dock (for example
 * the form event was lost while disconnected), trigger a bounded recovery that
 * joins the coalesced loaded-only pending-request sync, so the dock recovers in
 * seconds. Each part episode triggers at most twice — once after a 2 s grace,
 * so a slow dock delivery never triggers a sync, then once more 6 s later —
 * and disarms as soon as a matching form is docked or the part settles. A
 * fresh `running: true` after a settle starts a new episode; a repeated one
 * for the same live episode never re-arms. `now`/`setTimer`/`clearTimer` are
 * injectable so tests drive time manually; by default the coordinator runs on
 * real timers.
 */
export function createQuestionReconciliation(deps: QuestionReconciliationDeps) {
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const episodes = new Map<string, Episode>()
  let disposed = false

  const keyOf = (part: ArmedPart) => `${part.instanceId}\0${part.messageId}\0${part.partId}`

  const disarm = (key: string) => {
    const episode = episodes.get(key)
    if (!episode) return
    if (episode.timer !== undefined) clearTimer(episode.timer)
    episodes.delete(key)
  }

  // Evaluation consults the deps now, never the dock state from arm time.
  const evaluate = (key: string, episode: Episode) => {
    const { instanceId, messageId, partId } = episode.part
    if (deps.getForms(instanceId).some((form) => deps.matchesForm(form, messageId, partId))) {
      disarm(key)
      return
    }
    deps.schedule(instanceId)
    episode.attempts += 1
    if (episode.attempts >= MAX_SYNCS_PER_EPISODE) {
      episodes.delete(key)
      return
    }
    arm(key, episode, RETRY_MS)
  }

  const arm = (key: string, episode: Episode, delayMs: number) => {
    episode.armed = true
    episode.timer = setTimer(() => {
      if (episodes.get(key) !== episode) return
      episode.timer = undefined
      episode.armed = false
      try {
        evaluate(key, episode)
      } catch (error) {
        // The bus isolates hook-path failures the same way; a throwing dep on
        // the timer path must not surface as an unhandled timer error or leave
        // an unarmed episode behind. Drop it so a later running:true re-arms.
        log.error("Failed to evaluate question reconciliation episode", error)
        episodes.delete(key)
      }
    }, delayMs)
  }

  return {
    onQuestionPart(instanceId: string, sessionId: string, messageId: string, partId: string, running: boolean): void {
      if (disposed) return
      const part: ArmedPart = { instanceId, sessionId, messageId, partId }
      const key = keyOf(part)
      if (!running) {
        disarm(key)
        return
      }
      if (episodes.has(key)) return
      const episode: Episode = { part, armed: false, attempts: 0, timer: undefined }
      episodes.set(key, episode)
      arm(key, episode, GRACE_MS)
    },
    dispose(): void {
      disposed = true
      for (const key of [...episodes.keys()]) disarm(key)
    },
  }
}

// The instance owning a docked form's session; a form is only matched against
// that instance's transcript so resolveFormToolTarget reads the right store.
function instanceOwningSession(sessionId: string): string | undefined {
  for (const [instanceId, instanceSessions] of sessions()) {
    if (instanceSessions.has(sessionId)) return instanceId
  }
  return undefined
}

export const questionReconciliation = createQuestionReconciliation({
  // The trigger joins the coalesced loaded-only recovery: it must never abort
  // the recovery in progress or start ordinary permission/Form lists outside
  // the background-read budget, and compaction deferral stays handled by the
  // recovery itself instead of surfacing as an incomplete-recovery warning.
  schedule: (instanceId) => {
    syncPendingRequests(instanceId).catch((error) => {
      log.warn("Failed to recover pending requests for a running question part", { instanceId, error })
    })
  },
  getForms: (instanceId) => getFormQueue(instanceId),
  matchesForm: (form, messageId, partId) => {
    const instanceId = instanceOwningSession(form.sessionID)
    if (!instanceId) return false
    const store = messageStoreBus.getInstance(instanceId)
    if (!store) return false
    const target = resolveFormToolTarget(form, store)
    return target !== null && target.messageId === messageId && target.partId === partId
  },
})
