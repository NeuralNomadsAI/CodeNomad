import { stableToken } from "./receipt-identity"

// Roots that Missions creates use OpenCode's own descending session identifier
// (`ses_` + 12 lowercase hex encoding the creation time + 14 characters): OpenCode
// Zen's free tier refuses other identities, and children send their root's ID as
// session affinity. The 14 characters are derived from the mission identity, so
// ownership stays provable from the ID alone.
function sessionID(seed: string, createdAt: number): string {
  const time = ~(BigInt(createdAt) * 0x1000n + 1n) & 0xffff_ffff_ffffn
  return `ses_${time.toString(16).padStart(12, "0")}${stableToken(seed, 14)}`
}

/** Journals written before this format hold the original `ses_` + 26-hex derivation. */
function derivedFrom(id: string, seed: string): boolean {
  return /^ses_[0-9a-f]{12}[0-9a-f]{14}$/.test(id) && (id.slice(16) === stableToken(seed, 14) || id === `ses_${stableToken(seed, 26)}`)
}

const coordinatorSeed = (missionID: string) => `${missionID}\0coordinator`
const taskSeed = (missionID: string, taskID: string) => `${missionID}\0task\0${taskID}`

export const missionCoordinatorSessionID = (missionID: string, createdAt: number) => sessionID(coordinatorSeed(missionID), createdAt)
export const isMissionCoordinatorSession = (id: string, missionID: string) => derivedFrom(id, coordinatorSeed(missionID))
export const missionTaskSessionID = (missionID: string, taskID: string, createdAt: number) => sessionID(taskSeed(missionID, taskID), createdAt)
export const isMissionTaskSession = (id: string, missionID: string, taskID: string) => derivedFrom(id, taskSeed(missionID, taskID))
