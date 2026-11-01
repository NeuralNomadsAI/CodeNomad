import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

/** Fixture-owned contract traffic; stop and drain before removing the plugin or runtime. */
export async function startOfferRenewal(advertise, input, intervalMs = 3_000) {
  assert.equal((await advertise(input)).outcome, "accepted")
  const controller = new AbortController()
  let failure
  const work = (async () => {
    while (!controller.signal.aborted) {
      try { await delay(intervalMs, undefined, { signal: controller.signal }) }
      catch (error) { if (controller.signal.aborted) return; throw error }
      if (controller.signal.aborted) return
      assert.equal((await advertise(input)).outcome, "renewed", "The same live host offer renews")
    }
  })().catch(error => { failure = error })
  return async () => { controller.abort(); await work; if (failure) throw failure }
}

/** A terminal preparation failure wins over a historical confirmation view. */
export function findConfirmation(events, requestID) {
  const terminal = events.find(event => event.change?.requestID === requestID)?.change
  assert(!terminal, `Preparation terminated: ${terminal?.outcome}`)
  return events.find(event => event.view?.requestID === requestID)?.view
}
