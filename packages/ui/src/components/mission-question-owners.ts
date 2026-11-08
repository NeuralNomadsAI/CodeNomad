import type { MissionPanelMap } from "../../../server/src/api-types"
import { selectMissionAttention, type MissionAttentionForm, type MissionAttentionPermission, type MissionObservedFamily } from "./mission-attention-model"

/** Open native queue requests of a Mission: its actors' and their observed family's,
 * and those of conversations proven to be its native task conversations (exact
 * evidence, kept when family coverage is unknown). Unknown descendants and global
 * requests never count. */
export function nativeMissionQuestions(input: {
  actors: readonly { sessionId: string }[]; family?: MissionObservedFamily
  forms: readonly MissionAttentionForm[]; permissions: readonly MissionAttentionPermission[]
  isTaskSession: (sessionId: string) => boolean
}): MissionQuestion[] {
  // The actors' and family's requests, with the actors as the family's only roots.
  const correlated: MissionQuestion[] = selectMissionAttention({ actors: input.actors, forms: input.forms, permissions: input.permissions, tasks: [], family: input.family })
    .flatMap(item => item.open && item.sessionId && item.kind !== "blocked"
      ? [{ sessionId: item.sessionId, actorSessionId: item.actorSessionId, request: { kind: item.kind, id: item.id.slice(item.kind.length + 1) } }] : [])
  // Then the exact requests of proven native task conversations not already correlated.
  const known = new Set(correlated.map(question => `${question.request.kind}:${question.request.id}:${question.sessionId}`))
  const exact: MissionQuestion[] = [
    ...input.forms.map(form => ({ sessionId: form.sessionID, request: { kind: "form" as const, id: form.id } })),
    ...input.permissions.map(permission => ({ sessionId: permission.sessionID, request: { kind: "permission" as const, id: permission.id } })),
  ].filter(question => question.sessionId && question.sessionId !== "global" && input.isTaskSession(question.sessionId)
    && !known.has(`${question.request.kind}:${question.request.id}:${question.sessionId}`))
    .map(question => ({ ...question, actorSessionId: question.sessionId }))
  return [...correlated, ...exact]
}

/** An observation page's parts that question attribution reads. */
interface ObservationPage { requests: { state: string } }

/** The Mission's current observation pages: its own current activity windows, else
 * its current marks-lane window (a closed row's). Superseded or failed windows read
 * as `unknown`: never evidence, and never hiding current marks evidence. */
export function currentMissionObservations<Page extends ObservationPage>(store: {
  observations: (instanceId: string, missionId: string) => Page[]; markObservations: (instanceId: string, missionId: string) => Page[]
}, instanceId: string, missionId: string): Page[] {
  const current = (pages: Page[]) => pages.filter(page => page.requests.state !== "unknown")
  const own = current(store.observations(instanceId, missionId))
  return own.length ? own : current(store.markObservations(instanceId, missionId))
}

/** A still-open native Form or permission request of a Mission's family: the
 * conversation to open and the exact request to focus in its interruption dock. */
export interface MissionQuestion {
  sessionId: string
  request: { kind: "form" | "permission"; id: string }
  /** Nearest declared actor of the asking conversation. */
  actorSessionId?: string
}

/** Who a question belongs to, from the Mission's coordinator and whether a
 * conversation is a known native task conversation of the Mission. */
export interface MissionQuestionContext {
  coordinatorSessionId: string
  isTaskSession: (sessionId: string) => boolean
}

/** Whether the coordinator asks: its own conversation, or a family member of the
 * coordinator that no known task conversation carries (so it stays reachable from
 * the Mission's flag). Every other question belongs to a task. */
export function coordinatorAsks(context: MissionQuestionContext, question: MissionQuestion): boolean {
  if (question.sessionId === context.coordinatorSessionId) return true
  return (question.actorSessionId ?? context.coordinatorSessionId) === context.coordinatorSessionId
    && !context.isTaskSession(question.sessionId)
}

type QuestionTask = Pick<MissionPanelMap["tasks"][number], "status" | "actorSessionId" | "replacedByTaskKey">
const live = (task: QuestionTask) => !["completed", "failed", "withdrawn"].includes(task.status) && !task.replacedByTaskKey

/** The question a live task row carries: its declared actor's, or its exact conversation's. */
export function taskQuestion(context: MissionQuestionContext, questions: readonly MissionQuestion[],
  task: QuestionTask, conversation: string | undefined): MissionQuestion | undefined {
  if (!live(task)) return undefined
  return questions.find(question => !coordinatorAsks(context, question)
    && ((task.actorSessionId && task.actorSessionId !== context.coordinatorSessionId && question.actorSessionId === task.actorSessionId)
      || (conversation !== undefined && question.sessionId === conversation)))
}

/** Splits a Mission's questions between its flag and its tasks. With its map known,
 * a task's question no loaded live row carries (a task further down) also goes to
 * the flag, so every question stays one click away. */
export function missionQuestionOwners<Task extends QuestionTask>(context: MissionQuestionContext, questions: readonly MissionQuestion[],
  tasks?: readonly Task[], conversation?: (task: Task) => string | undefined): { flag: MissionQuestion[]; tasks: MissionQuestion[] } {
  const flag: MissionQuestion[] = [], carried: MissionQuestion[] = []
  if (!questions.length) return { flag, tasks: carried }
  // What the loaded live rows carry, indexed once (taskQuestion's rule): linear in tasks and questions.
  const actors = new Set<string>(), conversations = new Set<string>()
  for (const task of tasks ?? []) {
    if (!live(task)) continue
    if (task.actorSessionId && task.actorSessionId !== context.coordinatorSessionId) actors.add(task.actorSessionId)
    const linked = conversation?.(task)
    if (linked) conversations.add(linked)
  }
  for (const question of questions) {
    const owned = !coordinatorAsks(context, question)
      && (!tasks || (question.actorSessionId !== undefined && actors.has(question.actorSessionId)) || conversations.has(question.sessionId))
    ;(owned ? carried : flag).push(question)
  }
  return { flag, tasks: carried }
}
