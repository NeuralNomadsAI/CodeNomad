import { stableToken } from "./receipt-identity"

/** The exact decision task a coordinator question answers, written into the question the
 * human reads: the task key in clear and a code bound to its mission. An answer settles
 * only the decision its question names, so it cannot be rebound to another task or mission. */
export function decisionQuestionTag(missionID: string, taskKey: string): string {
  return `[decision ${taskKey} ${stableToken(`decision-question\0${missionID}\0${taskKey}`, 8)}]`
}
