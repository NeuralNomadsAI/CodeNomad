import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowBenchOwnedRoute,
  assertExactInjectedMultiset,
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
  const evenStats = summarizeLatencies([10, 40, 20, 30])
  assert.deepEqual(evenStats, {
    count: 4,
    minMs: 10,
    medianMs: 25,
    p95Ms: 40,
    maxMs: 40,
    totalMs: 100,
  })
  assert.throws(() => summarizeLatencies([]))
  assert.throws(() => summarizeLatencies([-1]))
})

test('assertSingleMultiplexedSse enforces 1 open HTTP 200 HTTP/1.1 hub EventSource', () => {
  const base = {
    constructorCalls: 1,
    activeCount: 1,
    openReadyCount: 1,
    cdpEventSourceRequests: 1,
    redirected: false,
    protocols: ['http/1.1'],
    statuses: [200],
    closedFlags: [false],
    connectionIds: ['hub-1'],
  }
  const ok = assertSingleMultiplexedSse(base)
  assert.deepEqual(ok, {
    constructorCalls: 1,
    activeCount: 1,
    openReadyCount: 1,
    cdpEventSourceRequests: 1,
    redirected: false,
    protocol: 'http/1.1',
    status: 200,
    closed: false,
    connectionId: 'hub-1',
  })

  assert.throws(() => assertSingleMultiplexedSse({...base, constructorCalls: 7, activeCount: 7, openReadyCount: 7, cdpEventSourceRequests: 7}))
  assert.throws(() => assertSingleMultiplexedSse({...base, openReadyCount: 0}))
  assert.throws(() => assertSingleMultiplexedSse({...base, redirected: true}))
  assert.throws(() => assertSingleMultiplexedSse({...base, protocols: ['h2']}))
  assert.throws(() => assertSingleMultiplexedSse({...base, statuses: [500]}))
  assert.throws(() => assertSingleMultiplexedSse({...base, closedFlags: [true]}))
  assert.throws(() => assertSingleMultiplexedSse({...base, connectionIds: ['hub-2']}))
  assert.throws(() => assertSingleMultiplexedSse({...base, connectionIds: ['stream-1']}))
})

test('evaluateConcurrentBatch validates 14 distinct CDP requestIds, method/path, no redirects on HTTP/1.1', () => {
  const results = Array.from({length: 14}, (_, i) => {
    const kind = i % 2 === 0 ? 'history-window' : 'worktrees'
    const workspaceId = `ws-${Math.floor(i / 2) + 1}`
    const method = kind === 'history-window' ? 'POST' : 'GET'
    const reqPath = kind === 'history-window'
      ? `/api/workspaces/${workspaceId}/session-history/window`
      : `/api/workspaces/${workspaceId}/worktrees`
    return {
      benchId: `bench-${i}`,
      kind,
      method,
      workspaceId,
      path: reqPath,
      requestId: `req-${i}`,
      cdpMethod: method,
      cdpPath: reqPath,
      cdpResponsePath: reqPath,
      cdpRedirected: false,
      cdpDuplicate: false,
      cdpResponseCount: 1,
      status: 200,
      cdpStatus: 200,
      ok: true,
      protocol: 'http/1.1',
      durationMs: 10 + i,
    }
  })
  const summary = evaluateConcurrentBatch(results, {expectedCount: 14, wallMs: 85.4, maxWallMs: 10000})
  assert.equal(summary.requestCount, 14)
  assert.equal(summary.distinctCdpRequests, 14)
  assert.equal(summary.wallMs, 85.4)
  assert.equal(summary.latencies.minMs, 10)
  assert.equal(summary.latencies.maxMs, 23)

  assert.throws(() => evaluateConcurrentBatch(results, {expectedCount: 14, wallMs: 12000, maxWallMs: 10000}))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], protocol: 'h2'}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], protocol: null}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], requestId: results[1].requestId}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpRedirected: true}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpDuplicate: true}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpMethod: 'GET'}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpResponsePath: '/api/other'}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpResponseCount: 2}, ...results.slice(1)],
    {expectedCount: 14, wallMs: 50},
  ))
  assert.throws(() => evaluateConcurrentBatch(
    [{...results[0], cdpStatus: 503}, ...results.slice(1)],
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
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session-history/outlinePreview', body: {sessionID: 'ses_tab_1'}, native: false}), true)
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session-history/window', body: {sessionID: 'ses_other'}, native: false}), false)
  assert.equal(allowBenchOwnedRoute({method: 'POST', path: 'session/ses_tab_1/prompt', native: true}), false)
})

test('assertExactInjectedMultiset rejects stray, duplicate, or misrouted injected SSE deltas', () => {
  const expected = [
    {assistantMessageID: 'sse-live-1', workspaceId: 'ws-1', sessionID: 'ses_tab_1', text: 'Tab 1'},
    {assistantMessageID: 'sse-live-1', workspaceId: 'ws-2', sessionID: 'ses_tab_1', text: 'Tab 1'},
  ]
  const exactFrames = expected.map(e => ({
    requestId: 'sse-1',
    nativeType: 'session.text.delta',
    assistantMessageID: e.assistantMessageID,
    instanceId: e.workspaceId,
    sessionID: e.sessionID,
    delta: e.text,
  }))
  assert.equal(assertExactInjectedMultiset(exactFrames, 'sse-1', expected), 2)
  assert.throws(() => assertExactInjectedMultiset([...exactFrames, exactFrames[0]], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([exactFrames[0], exactFrames[0]], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([
    ...exactFrames,
    {requestId: 'sse-1', nativeType: 'session.text.delta', assistantMessageID: 'sse-live-stray', instanceId: 'ws-1', sessionID: 'ses_tab_1', delta: 'Tab 1'},
  ], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([
    ...exactFrames,
    {requestId: 'sse-1', nativeType: 'session.text.delta', assistantMessageID: 'sse-live-1', instanceId: 'ws-wrong', sessionID: 'ses_tab_1', delta: 'Tab 1'},
  ], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([
    ...exactFrames,
    {requestId: 'sse-1', nativeType: 'session.text.delta', assistantMessageID: 'sse-live-1', instanceId: 'ws-1', sessionID: 'ses_tab_2', delta: 'Tab 1'},
  ], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([
    {...exactFrames[0], requestId: 'sse-2'},
    exactFrames[1],
  ], 'sse-1', expected))
  assert.throws(() => assertExactInjectedMultiset([
    ...exactFrames,
    {...exactFrames[0], assistantMessageID: ['sse-live-1']},
  ], 'sse-1', expected), {message: "Injected SSE frame assistantMessageID must be a string\n\n'object' !== 'string'\n"})
  assert.throws(() => assertExactInjectedMultiset([
    {...exactFrames[0], assistantMessageID: ['sse-live-1']},
    exactFrames[1],
  ], 'sse-1', expected), {message: "Injected SSE frame assistantMessageID must be a string\n\n'object' !== 'string'\n"})
  assert.throws(() => assertExactInjectedMultiset([
    {...exactFrames[0], instanceId: ['ws-1']},
    exactFrames[1],
  ], 'sse-1', expected), {message: "Injected SSE frame instanceId must be a string\n\n'object' !== 'string'\n"})
  assert.throws(() => assertExactInjectedMultiset([
    {...exactFrames[0], sessionID: ['ses_tab_1']},
    exactFrames[1],
  ], 'sse-1', expected), {message: "Injected SSE frame sessionID must be a string\n\n'object' !== 'string'\n"})
  assert.throws(() => assertExactInjectedMultiset([
    {...exactFrames[0], delta: ['Tab 1']},
    exactFrames[1],
  ], 'sse-1', expected), {message: "Injected SSE frame delta must be a string\n\n'object' !== 'string'\n"})
})
