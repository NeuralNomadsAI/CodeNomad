import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowBenchOwnedRoute,
  assertSingleMultiplexedSse,
  evaluateConcurrentBatch,
  summarizeLatencies,
} from './web-sse-7tabs.mjs'

test('summarizeLatencies computes min, median, p95, max, and total', () => {
  const stats = summarizeLatencies([12.4, 5.1, 40.9, 18.2, 7.3, 25.0, 9.8])
  assert.deepEqual(stats, {
    count: 7,
    minMs: 5.1,
    medianMs: 12.4,
    p95Ms: 40.9,
    maxMs: 40.9,
    totalMs: 118.7,
  })
  assert.throws(() => summarizeLatencies([]))
  assert.throws(() => summarizeLatencies([-1]))
})

test('assertSingleMultiplexedSse enforces 1 HTTP/1.1 hub EventSource', () => {
  const ok = assertSingleMultiplexedSse({
    constructorCalls: 1,
    activeCount: 1,
    cdpEventSourceRequests: 1,
    protocols: ['http/1.1'],
    connectionIds: ['hub-1'],
  })
  assert.deepEqual(ok, {
    constructorCalls: 1,
    activeCount: 1,
    cdpEventSourceRequests: 1,
    protocol: 'http/1.1',
    connectionId: 'hub-1',
  })

  assert.throws(() => assertSingleMultiplexedSse({
    constructorCalls: 7,
    activeCount: 7,
    cdpEventSourceRequests: 7,
    protocols: ['http/1.1'],
    connectionIds: ['hub-1'],
  }))
  assert.throws(() => assertSingleMultiplexedSse({
    constructorCalls: 1,
    activeCount: 1,
    cdpEventSourceRequests: 1,
    protocols: ['h2'],
    connectionIds: ['hub-1'],
  }))
  assert.throws(() => assertSingleMultiplexedSse({
    constructorCalls: 1,
    activeCount: 1,
    cdpEventSourceRequests: 1,
    protocols: ['http/1.1'],
    connectionIds: ['stream-1'],
  }))
})

test('evaluateConcurrentBatch validates 14 HTTP/1.1 responses and wall budget', () => {
  const results = Array.from({length: 14}, (_, i) => ({
    kind: i % 2 === 0 ? 'history-window' : 'worktrees',
    workspaceId: `ws-${Math.floor(i / 2) + 1}`,
    status: 200,
    ok: true,
    protocol: 'http/1.1',
    durationMs: 10 + i,
  }))
  const summary = evaluateConcurrentBatch(results, {expectedCount: 14, wallMs: 85.4, maxWallMs: 10000})
  assert.equal(summary.requestCount, 14)
  assert.equal(summary.wallMs, 85.4)
  assert.equal(summary.latencies.minMs, 10)
  assert.equal(summary.latencies.maxMs, 23)

  assert.throws(() => evaluateConcurrentBatch(results, {expectedCount: 14, wallMs: 12000, maxWallMs: 10000}))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], protocol: 'h2'}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
})

test('allowBenchOwnedRoute restricts routes strictly to ses_tab_1..ses_tab_7', () => {
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'session', native: true}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'command', native: true}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'model', native: true}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'session/ses_tab_1', native: true}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'session/ses_tab_7/permission', native: true}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'session/ses_tab_8', native: true}), false)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'worktrees', native: false}), true)
  assert.equal(allowBenchOwnedRoute({method: 'GET', path: 'sessions/ses_tab_4/permission-mode', native: false}), true)
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session-history/window', body: {sessionID: 'ses_tab_3'}, native: false}), true)
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session-history/window', body: {sessionID: 'ses_other'}, native: false}), false)
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session/ses_tab_1/prompt', native: true}), false)
})
