import assert from "node:assert/strict"
import test from "node:test"
import { stableToken } from "./receipt-identity"
import { isMissionCoordinatorSession, isMissionTaskSession, missionCoordinatorSessionID, missionTaskSessionID } from "./session-identity"

test("mission roots use OpenCode's descending identifier for their real creation time", () => {
  // Time prefixes of session IDs that OpenCode 2.1.4 generated at these milliseconds.
  for (const [prefix, createdAt] of [["e90c9425affe", 1792867220901], ["e90c8f1f0ffe", 1792867241487], ["e90c8af0effe", 1792867258609]] as const) {
    assert.equal(missionCoordinatorSessionID("msn_fixture", createdAt).slice(4, 16), prefix)
    assert.equal(missionTaskSessionID("msn_fixture", "tsk_fixture", createdAt).slice(4, 16), prefix)
  }
  const id = missionCoordinatorSessionID("msn_fixture", 1792867220901)
  assert.match(id, /^ses_[0-9a-f]{12}[0-9a-f]{14}$/)
  assert.equal(id.slice(16), stableToken("msn_fixture\0coordinator", 14))
  assert(missionCoordinatorSessionID("msn_fixture", 1792867220902) < id, "newer sessions sort first, as OpenCode's do")
})

test("ownership follows the derived suffix at any creation time and keeps the original derivation", () => {
  for (const createdAt of [1, 1792867220901, Date.now()]) {
    assert(isMissionCoordinatorSession(missionCoordinatorSessionID("msn_one", createdAt), "msn_one"))
    assert(isMissionTaskSession(missionTaskSessionID("msn_one", "tsk_one", createdAt), "msn_one", "tsk_one"))
  }
  assert(isMissionCoordinatorSession(`ses_${stableToken("msn_one\0coordinator", 26)}`, "msn_one"))
  assert(isMissionTaskSession(`ses_${stableToken("msn_one\0task\0tsk_one", 26)}`, "msn_one", "tsk_one"))

  const coordinator = missionCoordinatorSessionID("msn_one", 1792867220901)
  const task = missionTaskSessionID("msn_one", "tsk_one", 1792867220901)
  assert.equal(isMissionCoordinatorSession(coordinator, "msn_two"), false)
  assert.equal(isMissionCoordinatorSession(task, "msn_one"), false)
  assert.equal(isMissionTaskSession(task, "msn_one", "tsk_two"), false)
  assert.equal(isMissionTaskSession(coordinator, "msn_one", "tsk_one"), false)
  for (const foreign of ["ses_e90c9425affe3hOs30Yd5bK9Bn", `${coordinator}0`, coordinator.slice(0, -1), coordinator.toUpperCase().replace("SES_", "ses_")]) {
    assert.equal(isMissionCoordinatorSession(foreign, "msn_one"), false, foreign)
  }
})
