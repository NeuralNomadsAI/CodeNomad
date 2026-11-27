import assert from 'node:assert/strict'
import {test} from 'node:test'
import {admitLiveRoute, assertSse503Backoff, shouldServeSse503} from './web-live.mjs'
import {workspacePolicy} from './web-workspace-policy.mjs'

const origin = 'https://127.0.0.1:12345'
const project = 'D:/private/projects/synthetic'
const req = (url, {method = 'GET', cookie = 'private=fixture'} = {}) => ({
  url: () => url,
  method: () => method,
  postDataJSON: () => null,
  allHeaders: async () => (cookie ? {cookie} : {}),
})

test('admitLiveRoute records policy refusals in forbiddenRequests', async () => {
  const policy = workspacePolicy({origin, project})
  const forbiddenRequests = []
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`), {policy, origin, forbiddenRequests}), true)
  assert.equal(await admitLiveRoute(req(`${origin}/api/events?clientId=1`), {policy, origin, forbiddenRequests}), true)
  assert.deepEqual(forbiddenRequests, [])

  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {cookie: ''}), {policy, origin, forbiddenRequests}), false)
  assert.equal(await admitLiveRoute(req('https://localhost:12345/api/auth/status'), {policy, origin, forbiddenRequests}), false)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {method: 'POST'}), {policy, origin, forbiddenRequests}), false)
  assert.deepEqual(forbiddenRequests, [
    {origin, path: '/api/auth/status'},
    {origin: 'https://localhost:12345', path: '/api/auth/status'},
    {origin, path: '/api/auth/status'},
  ])
})

test('admitLiveRoute enforces GET, origin, and cookie without a policy and reports refusals', async () => {
  const forbiddenRequests = []
  const reported = []
  const onForbidden = err => reported.push(err.message)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`), {origin, forbiddenRequests, onForbidden}), true)
  assert.equal(await admitLiveRoute(req(`${origin}/api/events`, {cookie: ''}), {origin, forbiddenRequests, onForbidden}), false)
  assert.equal(await admitLiveRoute(req('https://evil.test/api/events'), {origin, forbiddenRequests, onForbidden}), false)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {method: 'POST'}), {origin, forbiddenRequests, onForbidden}), false)
  assert.deepEqual(forbiddenRequests, [
    {origin, path: '/api/events'},
    {origin: 'https://evil.test', path: '/api/events'},
    {origin, path: '/api/auth/status'},
  ])
  assert.deepEqual(reported, [
    `Forbidden live route request: GET ${origin}/api/events`,
    'Forbidden live route request: GET https://evil.test/api/events',
    `Forbidden live route request: POST ${origin}/api/auth/status`,
  ])
})

test('SSE 503 backoff requires independent handover proof for 4-5 probes and rejects unproved extra retries', () => {
  const probe = (receivedAt, fulfilledAt = receivedAt) => ({receivedAt, fulfilledAt})
  const handover = (sseOpenedAt, {conv = [], meta = []} = {}) => ({
    sseOpenedAt,
    conversationSyncTimes: conv,
    launcherMetaTimes: meta,
  })

  const single = [probe(0, 5), probe(1020, 1025), probe(3040, 3045)]
  assert.equal(shouldServeSse503(single.slice(0, 1)), true)
  assert.equal(shouldServeSse503(single.slice(0, 2)), true)
  assert.equal(shouldServeSse503(single), false)
  assert.deepEqual(assertSse503Backoff(single), {retryDelay1Ms: 1015, retryDelay2Ms: 2015, coalescedSlotProbes: 0})

  const muxFast = [probe(0, 5), probe(15, 20), probe(1030, 1035), probe(3050, 3055)]
  const fastHandover = handover(0, {conv: [3]})
  assert.equal(shouldServeSse503(muxFast.slice(0, 3), fastHandover), true)
  assert.equal(shouldServeSse503(muxFast, fastHandover), false)
  assert.deepEqual(assertSse503Backoff(muxFast, fastHandover), {retryDelay1Ms: 1010, retryDelay2Ms: 2015, coalescedSlotProbes: 1})

  // Overlapping window: handover at 815 ms followed by a slow 1700 ms first retry must still take priority over 3-probe completion.
  const muxOverlap = [probe(0, 5), probe(820, 825), probe(2525, 2530), probe(4650, 4655)]
  const slowHandover = handover(0, {conv: [810]})
  assert.equal(shouldServeSse503(muxOverlap.slice(0, 3), slowHandover), true)
  assert.equal(shouldServeSse503(muxOverlap, slowHandover), false)
  assert.throws(() => assertSse503Backoff(muxOverlap.slice(0, 3), slowHandover), /must not terminate early after a proved multiplexed handover/)
  assert.deepEqual(assertSse503Backoff(muxOverlap, slowHandover), {retryDelay1Ms: 1700, retryDelay2Ms: 2120, coalescedSlotProbes: 1})

  // Order A (Launcher first, Conversation second after retry 1): 5 probes.
  const muxAfterRetry1 = [probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565)]
  const lateConvHandover = handover(0, {conv: [1523]})
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), lateConvHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 4), lateConvHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1, lateConvHandover), false)
  assert.deepEqual(assertSse503Backoff(muxAfterRetry1, lateConvHandover), {retryDelay1Ms: 1010, retryDelay2Ms: 2020, coalescedSlotProbes: 2})

  // Order B (Conversation first on P0, Launcher /api/meta 200 second after retry 1): 5 probes.
  const lateMetaHandover = handover(0, {conv: [3], meta: [1508]})
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), lateMetaHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 4), lateMetaHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1, lateMetaHandover), false)
  assert.deepEqual(assertSse503Backoff(muxAfterRetry1, lateMetaHandover), {retryDelay1Ms: 1010, retryDelay2Ms: 2020, coalescedSlotProbes: 2})

  // One conversation signal at 830 ms cannot justify both P1 (820 ms) and P2 (835 ms) to allow an extra retry (5 probes).
  const doubleCounted = [probe(0, 5), probe(820, 825), probe(835, 840), probe(1850, 1855), probe(3870, 3875)]
  const singleSignalAt830 = handover(0, {conv: [830]})
  assert.equal(shouldServeSse503(doubleCounted.slice(0, 4), singleSignalAt830), false)
  assert.throws(() => assertSse503Backoff(doubleCounted.slice(0, 4), singleSignalAt830), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff(doubleCounted, singleSignalAt830), /cannot reuse a multiplexed handover already attributed to probe 2/)

  // Two Conversation syncs from the same generation (near P0 and P2) must not prove a 5-probe handover without a distinct Launcher signal.
  const sameSubscriberTwice = handover(0, {conv: [3, 1520]})
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), sameSubscriberTwice), false)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, sameSubscriberTwice), /5-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxOverlap, handover(0, {conv: [3, 810]})), /4-probe SSE 503 recovery requires independent proof/)

  // Unproved extra retries (1 s, 1 s, 2 s), single-channel /api/meta without conversation sync, and distant/stale signals must be rejected.
  const threeRetries = [probe(0, 5), probe(1010, 1015), probe(2020, 2025), probe(4030, 4035)]
  assert.equal(shouldServeSse503(threeRetries.slice(0, 3), fastHandover), false)
  assert.throws(() => assertSse503Backoff(threeRetries, fastHandover), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxFast), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxFast, handover(10, {conv: [3]})), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, fastHandover), /5-probe SSE 503 recovery requires independent proof/)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), handover(0, {conv: [100]})), false)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, {conv: [100]})), /5-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, {meta: [1508]})), /5-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, {conv: [3], meta: [1120]})), /5-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, {conv: [1700]})), /5-probe SSE 503 recovery requires independent proof/)

  assert.equal(shouldServeSse503([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)], fastHandover), false)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)], fastHandover), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(1020, 1025), probe(2030, 2035)], fastHandover), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(3005, 3010), probe(8010, 8015)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(5020, 5025)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(1035, 1040), probe(3050, 3055)], lateConvHandover), /5-probe multiplexed handover/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565), probe(6570, 6575)], lateConvHandover), /3 to 5/)
})
