import type { MissionPanelMap } from "../../../server/src/api-types"

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
  for (const question of questions) {
    const owned = !coordinatorAsks(context, question)
      && (!tasks || tasks.some(task => taskQuestion(context, [question], task, conversation?.(task))))
    ;(owned ? carried : flag).push(question)
  }
  return { flag, tasks: carried }
}
