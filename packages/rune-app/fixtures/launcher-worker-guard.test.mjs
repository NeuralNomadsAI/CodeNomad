import assert from 'node:assert/strict'
import test from 'node:test'
import {evaluateWorkerExit,needsOwnedWindowsWorker} from './launcher-worker-guard.mjs'

test('Windows Job Object worker wraps mobile, keyboard viewport, and mobile drawers fixtures', () => {
  for (const flag of [
    '--web-mobile',
    '--web-android',
    '--web-mobile-more-actions',
    '--web-keyboard-viewport',
    '--web-mobile-drawers',
    '--web-sse-7tabs',
  ]) {
    assert.equal(
      needsOwnedWindowsWorker(['node', 'launcher-fixture.mjs', flag], 'win32'),
      true,
      `${flag} must run inside the Windows Job Object worker`,
    )
    assert.equal(
      needsOwnedWindowsWorker(['node', 'launcher-fixture.mjs', flag, '--owned-mobile-worker'], 'win32'),
      false,
      `${flag} must not recurse once inside the worker`,
    )
    assert.equal(
      needsOwnedWindowsWorker(['node', 'launcher-fixture.mjs', flag], 'linux'),
      false,
      `${flag} only needs the Windows worker on win32`,
    )
  }
  assert.equal(
    needsOwnedWindowsWorker(['node', 'launcher-fixture.mjs', '--web'], 'win32'),
    false,
  )
})

test('evaluateWorkerExit marks spawn errors, supervisor code 86, and unconfirmed stops as not exited', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  const spawnFailed = evaluateWorkerExit({
    exit: { code: null, signal: null, error: enoent },
    proof: { result: 0 },
  })
  assert.equal(spawnFailed.workerExited, false)
  assert.equal(spawnFailed.workerExitCode, null)
  assert.equal(spawnFailed.workerSpawnError, 'spawn ENOENT')
  assert.equal(spawnFailed.finalResult, 1)

  const spawnWithCode = evaluateWorkerExit({
    exit: { code: 1, signal: null, error: enoent },
  })
  assert.equal(spawnWithCode.workerExited, false)
  assert.equal(spawnWithCode.workerExitCode, null)
  assert.equal(spawnWithCode.finalResult, 1)

  const incompleteTree = evaluateWorkerExit({
    exit: { code: 86, signal: null },
    proof: { result: 0 },
  })
  assert.equal(incompleteTree.workerExited, false)
  assert.equal(incompleteTree.workerExitCode, 86)
  assert.equal(incompleteTree.workerStopError, 'Fixture supervisor reported incomplete child tree termination')
  assert.equal(incompleteTree.finalResult, 1)

  const escalated = evaluateWorkerExit({
    exit: { code: null, signal: 'SIGKILL' },
    unconfirmedStop: true,
    stopError: new Error('Owned POSIX bridge did not confirm worker exit before escalation'),
    outerSignal: 'SIGINT',
    proof: { result: 0, interruptedSignal: 'SIGTERM' },
  })
  assert.equal(escalated.workerExited, false)
  assert.equal(escalated.interrupted, 'SIGINT')
  assert.equal(escalated.workerStopError, 'Owned POSIX bridge did not confirm worker exit before escalation')
  assert.equal(escalated.finalResult, 1)

  const supervisorOnlyExit = evaluateWorkerExit({
    exit: { code: 1, signal: null },
    workerStarted: false,
  })
  assert.equal(supervisorOnlyExit.workerExited, false)
  assert.equal(supervisorOnlyExit.workerExitCode, null)
  assert.equal(supervisorOnlyExit.workerSpawnError, 'Owned worker did not start (supervisor exit code=1, signal=null)')
  assert.equal(supervisorOnlyExit.finalResult, 1)

  const unconfirmedOnly = evaluateWorkerExit({
    exit: { code: 0, signal: null },
    unconfirmedStop: true,
    proof: { result: 0 },
  })
  assert.equal(unconfirmedOnly.workerExited, false)
  assert.equal(unconfirmedOnly.workerStopError, 'Owned worker exit was not confirmed after stop')
  assert.equal(unconfirmedOnly.finalResult, 1)

  const clean = evaluateWorkerExit({
    exit: { code: 0, signal: null },
    proof: { result: 0 },
  })
  assert.equal(clean.workerExited, true)
  assert.equal(clean.workerExitCode, 0)
  assert.equal(clean.finalResult, 0)
})
