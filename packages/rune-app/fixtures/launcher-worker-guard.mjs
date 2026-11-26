import assert from 'node:assert/strict'
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {lstat,realpath} from 'node:fs/promises'
import path from 'node:path'

export function needsOwnedWindowsWorker(argv, platform = process.platform) {
  if (platform !== 'win32' || argv.includes('--owned-mobile-worker')) return false
  return argv.includes('--web-android')
    || argv.includes('--web-mobile-more-actions')
    || argv.includes('--web-mobile')
    || argv.includes('--web-keyboard-viewport')
    || argv.includes('--web-mobile-drawers')
    || argv.includes('--web-sse-7tabs')
}

export async function claimOwnedWorkerProfile(workerProfilePath, testsReal, token, pid = process.pid) {
  assert(typeof token === 'string' && token.length > 0, 'Worker start token is required')
  const canonicalRoot = await realpath(testsReal)
  const resolvedProfile = path.resolve(workerProfilePath)
  assert.equal(path.dirname(resolvedProfile), canonicalRoot, `Worker profile must reside under ${canonicalRoot}`)
  assert.match(path.basename(resolvedProfile), /^launcher-[0-9a-f-]+$/i, 'Unexpected worker profile directory name')
  const stat = await lstat(resolvedProfile)
  assert(!stat.isSymbolicLink() && stat.isDirectory(), `Worker profile must be a real directory: ${resolvedProfile}`)
  const profileReal = await realpath(resolvedProfile)
  assert.equal(path.dirname(profileReal), canonicalRoot, `Worker profile canonical path must reside under ${canonicalRoot}`)
  writeFileSync(path.join(profileReal, '.worker-started'), `${token}\n${pid}\n`, { flag: 'wx' })
  return profileReal
}

export function readOwnedWorkerStarted(workerProfile, token) {
  if (typeof token !== 'string' || !token.length) return false
  const markerPath = path.join(workerProfile, '.worker-started')
  let fd = null
  try {
    const linkStat = lstatSync(markerPath)
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) return false
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
    fd = openSync(markerPath, flags)
    const fdStat = fstatSync(fd)
    if (!fdStat.isFile() || fdStat.dev !== linkStat.dev || fdStat.ino !== linkStat.ino) return false
    const [firstLine] = readFileSync(fd, 'utf8').split(/\r?\n/)
    return firstLine === token
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

export function evaluateWorkerExit({ exit, workerStarted = true, unconfirmedStop = false, stopError = null, outerSignal = null, proof = null }) {
  const spawnError = exit?.error ?? (!workerStarted && exit && exit.code !== 86
    ? new Error(`Owned worker did not start (supervisor exit code=${exit.code}, signal=${exit.signal})`)
    : null)
  const workerExited = exit !== null && !spawnError && !unconfirmedStop && exit.code !== 86 && exit.signal === null && !stopError
  const workerCode = exit && !spawnError ? (exit.code ?? (exit.signal === 'SIGINT' ? 130 : exit.signal === 'SIGTERM' ? 143 : 1)) : null
  const supervisorFailed = !workerExited || workerCode !== 0 || Boolean(exit?.signal) || Boolean(spawnError) || Boolean(stopError)
  const interrupted = outerSignal ?? proof?.interruptedSignal ?? exit?.signal ?? (workerCode === 130 ? 'SIGINT' : workerCode === 143 ? 'SIGTERM' : null)
  const finalResult = proof?.result === 0 && !supervisorFailed && !interrupted ? 0 : 1
  const workerStopError = stopError
    ? String(stopError?.message ?? stopError)
    : !workerExited && !spawnError
      ? (exit?.code === 86 ? 'Fixture supervisor reported incomplete child tree termination' : 'Owned worker exit was not confirmed after stop')
      : undefined
  return {
    workerExited,
    workerCode,
    supervisorFailed,
    interrupted,
    finalResult,
    workerExitCode: exit && !spawnError ? exit.code : null,
    workerExitSignal: exit && !spawnError ? exit.signal : null,
    ...(workerStopError ? { workerStopError } : {}),
    ...(spawnError ? { workerSpawnError: String(spawnError?.message ?? spawnError) } : {}),
  }
}

export function publishWorkerProof({ workerProfile, workerToken, exit, unconfirmedStop = false, stopError = null, outerSignal = null }) {
  assert(typeof workerToken === 'string' && workerToken.length > 0, 'Worker start token is required')
  const workerProofFile = path.join(workerProfile, 'proof.worker.json.tmp')
  const supervisorProofTmp = path.join(workerProfile, 'proof.supervisor.json.tmp')
  const proofFile = path.join(workerProfile, 'proof.json')
  const workerStarted = readOwnedWorkerStarted(workerProfile, workerToken)
  let proof
  try { proof = JSON.parse(readFileSync(workerProofFile, 'utf8')) } catch {}
  const verdict = evaluateWorkerExit({ exit, workerStarted, unconfirmedStop, stopError, outerSignal, proof })
  const { workerExited, interrupted, finalResult, workerExitCode, workerExitSignal, workerStopError, workerSpawnError } = verdict
  const finalProof = {
    ...(proof ?? { profile: workerProfile }),
    result: finalResult,
    interruptedSignal: interrupted,
    workerExited,
    workerExitCode,
    workerExitSignal,
    ...(workerStopError ? { workerStopError } : {}),
    ...(workerSpawnError ? { workerSpawnError } : {}),
  }
  writeFileSync(supervisorProofTmp, JSON.stringify(finalProof, null, 2))
  renameSync(supervisorProofTmp, proofFile)
  if (workerExited) {
    try { unlinkSync(workerProofFile) } catch {}
  }
  return finalResult
}
