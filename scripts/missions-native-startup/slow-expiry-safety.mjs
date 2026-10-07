import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

// Evidence of automatic LocationActivity eviction, NOT an observed execution interruption reason.
export function requireAutomaticEviction(log, { directory, heldAt, beforeTailAt }) {
  assert.ok(Number.isFinite(heldAt) && Number.isFinite(beforeTailAt) && beforeTailAt >= heldAt + 60 * 60_000)
  const event = log.split("\n").filter(line => line.includes('message="location services evicted"')
    && line.includes(`directory=${JSON.stringify(directory)} `) && /(?:^| )role=server(?: |$)/.test(line))
    .map(line => ({ at: Date.parse(line.match(/(?:^| )timestamp=([^ ]+)/)?.[1]), run: line.match(/(?:^| )run=([^ ]+)/)?.[1] }))
    .find(entry => entry.run && entry.at >= heldAt + 60 * 60_000 && entry.at <= beforeTailAt)
  assert.ok(event, "Mandatory exact-root native LocationActivity eviction in held+60min/pre-tail window")
  return { ...event, kind: "native-automatic-location-eviction", exactExecutionInterruptionReason: null }
}

export async function readAutomaticEviction(file, bounds) {
  assert.ok((await stat(file)).size <= 8 * 1024 * 1024)
  const bytes = await readFile(file)
  return { ...requireAutomaticEviction(bytes.toString("utf8"), bounds), logSHA256: createHash("sha256").update(bytes).digest("hex") }
}

// Memoize concurrent teardown only; a negative ACK remains retryable, never becomes success.
export function memoizedTeardown(attempt) {
  let active, confirmed
  return () => confirmed ? Promise.resolve(confirmed) : active ??= Promise.resolve().then(attempt)
    .then(result => { if (result.confirmed) confirmed = result; return result })
    .finally(() => { active = undefined })
}

export function cleanupAcknowledged(ack, workerClosed) {
  if (ack?.kind === "never-admitted") return workerClosed === true && ack.confirmed === true
    && ack.privateRegistrationVerifiedAbsent === true && ack.noSentinelHandle === true
    && ack.runtimePhase?.serviceAdmissionAttempted === false && ack.runtimePhase?.sentinelAdmissionAttempted === false
  const managedReleased = ack?.managedExitObserved === true || (ack?.managedNeverAdmittedVerified === true
    && ack.privateRegistrationVerifiedAbsent === true && ack.runtimePhase?.serviceAdmissionAttempted === false)
  return workerClosed === true && managedReleased && ack?.sentinelCloseObserved === true
    && ack?.sentinelPreservedBeforeClose === true
}

export async function closeOwnedSentinel(sentinel, verifyPreserved, timeoutMs = 5_000) {
  await verifyPreserved() // A kill request must never precede the preservation read.
  sentinel.child.kill()
  let timer
  const closed = await Promise.race([sentinel.done.then(() => true), new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })]).finally(() => clearTimeout(timer))
  return { sentinelPreservedBeforeClose: true, sentinelCloseObserved: closed }
}

export async function observeOwnedExit(pid, timeoutMs = 5_000) {
  assert.ok(Number.isInteger(pid) && pid > 0)
  const deadline = Date.now() + timeoutMs
  do {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === "ESRCH") return true
      throw error
    }
    await delay(50)
  } while (Date.now() < deadline)
  return false
}
