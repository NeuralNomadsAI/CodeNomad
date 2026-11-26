import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {mkdir,mkdtemp,rm,symlink} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {claimOwnedWorkerProfile,evaluateWorkerExit,needsOwnedWindowsWorker,publishWorkerProof} from './launcher-worker-guard.mjs'

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

test('claimOwnedWorkerProfile rejects links and preexisting markers, and publishWorkerProof records unstarted bridge failure', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cn-worker-guard-'))
  try {
    const testsRoot = path.join(tmpRoot, 'tests')
    const outsideDir = path.join(tmpRoot, 'outside')
    await mkdir(testsRoot, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const realProfile = path.join(testsRoot, 'launcher-12345678-1234-1234-1234-123456789abc')
    await mkdir(realProfile)
    const claimed = await claimOwnedWorkerProfile(realProfile, testsRoot, 4242)
    assert.equal(readFileSync(path.join(claimed, '.worker-started'), 'utf8'), '4242')
    await assert.rejects(
      () => claimOwnedWorkerProfile(realProfile, testsRoot, 4242),
      { code: 'EEXIST' },
    )

    const linkProfile = path.join(testsRoot, 'launcher-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    await symlink(outsideDir, linkProfile, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(
      () => claimOwnedWorkerProfile(linkProfile, testsRoot, 4242),
      /must be a real directory/,
    )
    assert.equal(existsSync(path.join(outsideDir, '.worker-started')), false)

    const unstartedProfile = path.join(testsRoot, 'launcher-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    await mkdir(unstartedProfile)
    const result = publishWorkerProof({
      workerProfile: unstartedProfile,
      exit: { code: 1, signal: null },
      workerStarted: existsSync(path.join(unstartedProfile, '.worker-started')),
    })
    assert.equal(result, 1)
    const proof = JSON.parse(readFileSync(path.join(unstartedProfile, 'proof.json'), 'utf8'))
    assert.equal(proof.result, 1)
    assert.equal(proof.workerExited, false)
    assert.equal(proof.workerExitCode, null)
    assert.equal(proof.workerStopError, undefined)
    assert.equal(proof.workerSpawnError, 'Owned worker did not start (supervisor exit code=1, signal=null)')
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
