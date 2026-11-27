import assert from 'node:assert/strict'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {mkdir,mkdtemp,realpath,rm,symlink} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createWorkerStartAck,evaluateWorkerExit,needsOwnedWindowsWorker,publishWorkerProof,sendWorkerStartAck,validateOwnedWorkerProfile} from './launcher-worker-guard.mjs'

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

test('evaluateWorkerExit separates bridge, supervisor, and worker statuses and leaves unverified worker status indeterminate', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  const spawnFailed = evaluateWorkerExit({
    supervisorExit: { code: null, signal: null, error: enoent },
    workerStarted: false,
    proof: { result: 0 },
  })
  assert.equal(spawnFailed.workerExited, false)
  assert.equal(spawnFailed.workerExitCode, null)
  assert.equal(spawnFailed.workerSpawnError, 'spawn ENOENT')
  assert.equal(spawnFailed.finalResult, 1)

  const spawnWithCode = evaluateWorkerExit({
    supervisorExit: { code: 1, signal: null, error: enoent },
    workerStarted: false,
  })
  assert.equal(spawnWithCode.workerExited, false)
  assert.equal(spawnWithCode.workerExitCode, null)
  assert.equal(spawnWithCode.finalResult, 1)

  const incompleteTree = evaluateWorkerExit({
    supervisorExit: { code: 86, signal: null },
    bridgeExit: { code: 86, signal: null },
    proof: { result: 0 },
  })
  assert.equal(incompleteTree.workerExited, false)
  assert.equal(incompleteTree.workerExitCode, null)
  assert.equal(incompleteTree.supervisorExitCode, 86)
  assert.equal(incompleteTree.supervisorExitSignal, null)
  assert.equal(incompleteTree.bridgeExitCode, 86)
  assert.equal(incompleteTree.bridgeExitSignal, null)
  assert.equal(incompleteTree.workerStopError, 'Fixture supervisor reported incomplete child tree termination')
  assert.equal(incompleteTree.finalResult, 1)

  const posixKilledWorkerCollapsed = evaluateWorkerExit({
    supervisorExit: { code: 1, signal: null },
    bridgeExit: { code: 1, signal: null },
    workerStarted: true,
    proof: null,
  })
  assert.equal(posixKilledWorkerCollapsed.workerExited, null)
  assert.equal(posixKilledWorkerCollapsed.workerExitCode, null)
  assert.equal(posixKilledWorkerCollapsed.workerExitSignal, null)
  assert.equal(posixKilledWorkerCollapsed.supervisorExitCode, 1)
  assert.equal(posixKilledWorkerCollapsed.supervisorExitSignal, null)
  assert.equal(posixKilledWorkerCollapsed.bridgeExitCode, 1)
  assert.equal(posixKilledWorkerCollapsed.bridgeExitSignal, null)
  assert.equal(posixKilledWorkerCollapsed.workerStopError, undefined)
  assert.equal(posixKilledWorkerCollapsed.finalResult, 1)

  const posixEscalated = evaluateWorkerExit({
    supervisorExit: { code: 1, signal: null },
    bridgeExit: { code: 1, signal: null },
    workerStarted: true,
    escalatedStop: true,
    outerSignal: 'SIGTERM',
    proof: { result: 0 },
  })
  assert.equal(posixEscalated.workerExited, false)
  assert.equal(posixEscalated.workerExitCode, null)
  assert.equal(posixEscalated.workerExitSignal, null)
  assert.equal(posixEscalated.workerStopEscalated, true)
  assert.equal(posixEscalated.supervisorExitCode, 1)
  assert.equal(posixEscalated.supervisorExitSignal, null)
  assert.equal(posixEscalated.bridgeExitCode, 1)
  assert.equal(posixEscalated.bridgeExitSignal, null)
  assert.equal(posixEscalated.interrupted, 'SIGTERM')
  assert.equal(posixEscalated.workerStopError, 'Owned worker did not exit within grace period; supervisor forced termination')
  assert.equal(posixEscalated.finalResult, 1)

  const preLaunchInterrupt = evaluateWorkerExit({
    supervisorExit: null,
    bridgeExit: null,
    workerStarted: false,
    outerSignal: 'SIGINT',
  })
  assert.equal(preLaunchInterrupt.workerExited, false)
  assert.equal(preLaunchInterrupt.workerExitCode, null)
  assert.equal(preLaunchInterrupt.workerExitSignal, null)
  assert.equal(preLaunchInterrupt.interrupted, 'SIGINT')
  assert.equal(preLaunchInterrupt.workerStopError, undefined)
  assert.equal(preLaunchInterrupt.workerSpawnError, undefined)
  assert.equal(preLaunchInterrupt.finalResult, 1)

  const escalated = evaluateWorkerExit({
    supervisorExit: null,
    bridgeExit: { code: null, signal: 'SIGKILL' },
    escalatedStop: true,
    unconfirmedStop: true,
    stopError: new Error('Owned POSIX bridge did not confirm worker exit before escalation'),
    outerSignal: 'SIGINT',
    proof: { result: 0, interruptedSignal: 'SIGTERM' },
  })
  assert.equal(escalated.workerExited, false)
  assert.equal(escalated.workerExitCode, null)
  assert.equal(escalated.workerExitSignal, null)
  assert.equal(escalated.workerStopEscalated, true)
  assert.equal(escalated.supervisorExitCode, undefined)
  assert.equal(escalated.bridgeExitCode, null)
  assert.equal(escalated.bridgeExitSignal, 'SIGKILL')
  assert.equal(escalated.interrupted, 'SIGINT')
  assert.equal(escalated.workerStopError, 'Owned POSIX bridge did not confirm worker exit before escalation')
  assert.equal(escalated.finalResult, 1)

  const supervisorOnlyExit = evaluateWorkerExit({
    supervisorExit: { code: 1, signal: null },
    workerStarted: false,
  })
  assert.equal(supervisorOnlyExit.workerExited, false)
  assert.equal(supervisorOnlyExit.workerExitCode, null)
  assert.equal(supervisorOnlyExit.supervisorExitCode, 1)
  assert.equal(supervisorOnlyExit.workerSpawnError, 'Owned worker did not start (supervisor exit code=1, signal=null)')
  assert.equal(supervisorOnlyExit.finalResult, 1)

  const unconfirmedOnly = evaluateWorkerExit({
    supervisorExit: { code: 0, signal: null },
    unconfirmedStop: true,
    proof: { result: 0 },
  })
  assert.equal(unconfirmedOnly.workerExited, false)
  assert.equal(unconfirmedOnly.workerStopError, 'Owned worker exit was not confirmed after stop')
  assert.equal(unconfirmedOnly.finalResult, 1)

  const clean = evaluateWorkerExit({
    supervisorExit: { code: 0, signal: null },
    proof: { result: 0 },
  })
  assert.equal(clean.workerExited, true)
  assert.equal(clean.workerExitCode, 0)
  assert.equal(clean.supervisorExitCode, 0)
  assert.equal(clean.bridgeExitCode, undefined)
  assert.equal(clean.finalResult, 0)

  const cleanPosix = evaluateWorkerExit({
    supervisorExit: { code: 0, signal: null },
    bridgeExit: { code: 0, signal: null },
    proof: { result: 0 },
  })
  assert.equal(cleanPosix.workerExited, true)
  assert.equal(cleanPosix.workerExitCode, 0)
  assert.equal(cleanPosix.supervisorExitCode, 0)
  assert.equal(cleanPosix.bridgeExitCode, 0)
  assert.equal(cleanPosix.finalResult, 0)
})

test('validateOwnedWorkerProfile rejects links and loopback start ack authenticates worker startup', async () => {
  const ack = await createWorkerStartAck('tok-run-1')
  try {
    assert.equal(ack.hasStarted(), false)
    await assert.rejects(() => sendWorkerStartAck(ack.port, 'tok-wrong'))
    assert.equal(ack.hasStarted(), false)
    const conn1 = net.createConnection({ host: '127.0.0.1', port: ack.port })
    const conn2 = net.createConnection({ host: '127.0.0.1', port: ack.port })
    await Promise.all([
      new Promise((resolve, reject) => { conn1.once('connect', resolve); conn1.once('error', reject) }),
      new Promise((resolve, reject) => { conn2.once('connect', resolve); conn2.once('error', reject) }),
    ])
    const conn1Reply = new Promise((resolve, reject) => {
      let buf = ''
      conn1.on('data', d => { buf += d.toString('utf8') })
      conn1.once('end', () => resolve(buf))
      conn1.once('error', reject)
    })
    const conn2Result = new Promise(resolve => {
      let buf = ''
      conn2.on('data', d => { buf += d.toString('utf8') })
      conn2.once('close', () => resolve(buf))
      conn2.on('error', () => {})
    })
    conn1.write('tok-run-1\n')
    assert.equal(await conn1Reply, 'OK\n')
    assert.equal(ack.hasStarted(), true)
    try { conn2.write('tok-run-1\n') } catch {}
    assert.equal(await conn2Result, '')
    conn1.destroy()
    conn2.destroy()
  } finally {
    ack.close()
  }

  const unstartedAck = await createWorkerStartAck('tok-run-2')
  try {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cn-worker-guard-'))
    try {
      const rawTestsRoot = path.join(tmpRoot, 'tests')
      const outsideDir = path.join(tmpRoot, 'outside')
      await mkdir(rawTestsRoot, { recursive: true })
      await mkdir(outsideDir, { recursive: true })
      const testsRoot = await realpath(rawTestsRoot)

      const realProfile = path.join(testsRoot, 'launcher-12345678-1234-1234-1234-123456789abc')
      await mkdir(realProfile)
      const validated = await validateOwnedWorkerProfile(realProfile, testsRoot)
      assert.equal(validated, realProfile)

      const linkProfile = path.join(testsRoot, 'launcher-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
      await symlink(outsideDir, linkProfile, process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(
        () => validateOwnedWorkerProfile(linkProfile, testsRoot),
        /must be a real directory/,
      )

      const unstartedProfile = path.join(testsRoot, 'launcher-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
      await mkdir(unstartedProfile)
      const result = publishWorkerProof({
        workerProfile: unstartedProfile,
        supervisorExit: { code: 1, signal: null },
        workerStarted: unstartedAck.hasStarted(),
      })
      assert.equal(result, 1)
      const proof = JSON.parse(readFileSync(path.join(unstartedProfile, 'proof.json'), 'utf8'))
      assert.equal(proof.result, 1)
      assert.equal(proof.workerExited, false)
      assert.equal(proof.workerExitCode, null)
      assert.equal(proof.supervisorExitCode, 1)
      assert.equal(proof.workerStopError, undefined)
      assert.equal(proof.workerSpawnError, 'Owned worker did not start (supervisor exit code=1, signal=null)')

      assert.throws(
        () => publishWorkerProof({ workerProfile: realProfile, supervisorExit: { code: 0, signal: null } }),
        /workerStarted must be a boolean/,
      )

      writeFileSync(path.join(realProfile, 'proof.worker.json.tmp'), JSON.stringify({ result: 0 }))
      const verifiedResult = publishWorkerProof({
        workerProfile: realProfile,
        supervisorExit: { code: 0, signal: null },
        workerStarted: ack.hasStarted(),
      })
      assert.equal(verifiedResult, 0)
      assert.equal(existsSync(path.join(realProfile, 'proof.worker.json.tmp')), false)
      const verifiedProof = JSON.parse(readFileSync(path.join(realProfile, 'proof.json'), 'utf8'))
      assert.equal(verifiedProof.result, 0)
      assert.equal(verifiedProof.workerExited, true)
      assert.equal(verifiedProof.supervisorExitCode, 0)

      const escalatedProfile = path.join(testsRoot, 'launcher-cccccccc-cccc-cccc-cccc-cccccccccccc')
      await mkdir(escalatedProfile)
      writeFileSync(path.join(escalatedProfile, 'proof.worker.json.tmp'), JSON.stringify({ result: 0 }))
      const escalatedResult = publishWorkerProof({
        workerProfile: escalatedProfile,
        supervisorExit: { code: 1, signal: null },
        bridgeExit: { code: 1, signal: null },
        workerStarted: true,
        escalatedStop: true,
        outerSignal: 'SIGTERM',
      })
      assert.equal(escalatedResult, 1)
      const escalatedProof = JSON.parse(readFileSync(path.join(escalatedProfile, 'proof.json'), 'utf8'))
      assert.equal(escalatedProof.result, 1)
      assert.equal(escalatedProof.workerExited, false)
      assert.equal(escalatedProof.workerExitCode, null)
      assert.equal(escalatedProof.workerStopEscalated, true)
      assert.equal(escalatedProof.supervisorExitCode, 1)
      assert.equal(escalatedProof.supervisorExitSignal, null)
      assert.equal(escalatedProof.bridgeExitCode, 1)
      assert.equal(escalatedProof.bridgeExitSignal, null)
      assert.equal(escalatedProof.interruptedSignal, 'SIGTERM')

      const interruptedProfile = path.join(testsRoot, 'launcher-dddddddd-dddd-dddd-dddd-dddddddddddd')
      await mkdir(interruptedProfile)
      const interruptedResult = publishWorkerProof({
        workerProfile: interruptedProfile,
        workerStarted: false,
        outerSignal: 'SIGINT',
      })
      assert.equal(interruptedResult, 1)
      const interruptedProof = JSON.parse(readFileSync(path.join(interruptedProfile, 'proof.json'), 'utf8'))
      assert.equal(interruptedProof.result, 1)
      assert.equal(interruptedProof.workerExited, false)
      assert.equal(interruptedProof.workerExitCode, null)
      assert.equal(interruptedProof.interruptedSignal, 'SIGINT')
      assert.equal(interruptedProof.workerStopError, undefined)
      assert.equal(interruptedProof.workerSpawnError, undefined)

      const collapsedProfile = path.join(testsRoot, 'launcher-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
      await mkdir(collapsedProfile)
      const collapsedResult = publishWorkerProof({
        workerProfile: collapsedProfile,
        supervisorExit: { code: 1, signal: null },
        bridgeExit: { code: 1, signal: null },
        workerStarted: true,
      })
      assert.equal(collapsedResult, 1)
      const collapsedProof = JSON.parse(readFileSync(path.join(collapsedProfile, 'proof.json'), 'utf8'))
      assert.equal(collapsedProof.result, 1)
      assert.equal(collapsedProof.workerExited, null)
      assert.equal(collapsedProof.workerExitCode, null)
      assert.equal(collapsedProof.workerExitSignal, null)
      assert.equal(collapsedProof.supervisorExitCode, 1)
      assert.equal(collapsedProof.bridgeExitCode, 1)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  } finally {
    unstartedAck.close()
  }
})
