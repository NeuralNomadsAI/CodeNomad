import assert from 'node:assert/strict'
import {readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {lstat,realpath} from 'node:fs/promises'
import net from 'node:net'
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

export async function validateOwnedWorkerProfile(workerProfilePath, testsReal) {
  const canonicalRoot = await realpath(testsReal)
  const resolvedProfile = path.resolve(workerProfilePath)
  assert.equal(path.dirname(resolvedProfile), canonicalRoot, `Worker profile must reside under ${canonicalRoot}`)
  assert.match(path.basename(resolvedProfile), /^launcher-[0-9a-f-]+$/i, 'Unexpected worker profile directory name')
  const stat = await lstat(resolvedProfile)
  assert(!stat.isSymbolicLink() && stat.isDirectory(), `Worker profile must be a real directory: ${resolvedProfile}`)
  const profileReal = await realpath(resolvedProfile)
  assert.equal(path.dirname(profileReal), canonicalRoot, `Worker profile canonical path must reside under ${canonicalRoot}`)
  return profileReal
}

export async function createWorkerStartAck(token) {
  assert(typeof token === 'string' && token.length > 0, 'Worker start token is required')
  let started = false
  const sockets = new Set()
  const server = net.createServer(socket => {
    if (started) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    let data = ''
    let settled = false
    const finish = ok => {
      if (settled) return
      settled = true
      if (ok && !started) {
        started = true
        socket.end('OK\n')
        server.close()
        for (const other of sockets) {
          if (other !== socket) other.destroy()
        }
      } else {
        socket.destroy()
      }
    }
    socket.setTimeout(2000, () => finish(false))
    socket.on('error', () => {})
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
      const nl = data.indexOf('\n')
      if (nl >= 0) {
        finish(data.slice(0, nl).replace(/\r$/, '') === token)
      } else if (data.length > token.length + 2) {
        finish(false)
      }
    })
    socket.once('end', () => finish(false))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.unref()
  return {
    port: server.address().port,
    hasStarted: () => started,
    close: () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      try { server.close() } catch {}
    },
  }
}

export async function sendWorkerStartAck(port, token) {
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Invalid worker ack port')
  assert(typeof token === 'string' && token.length > 0, 'Worker start token is required')
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let reply = ''
    let settled = false
    const done = err => {
      if (settled) return
      settled = true
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(5000, () => done(new Error('Timed out acknowledging owned worker startup')))
    socket.once('error', done)
    socket.once('connect', () => { socket.write(`${token}\n`) })
    socket.on('data', chunk => {
      reply += chunk.toString('utf8')
      if (reply.includes('\n')) {
        if (reply.split('\n')[0].replace(/\r$/, '') === 'OK') done(null)
        else done(new Error('Unexpected worker startup acknowledgement reply'))
      }
    })
    socket.once('end', () => done(new Error('Worker startup acknowledgement closed before OK')))
  })
}

export function evaluateWorkerExit({ exit, workerStarted = true, escalatedStop = false, unconfirmedStop = false, stopError = null, outerSignal = null, proof = null, supervisorExit = null }) {
  const effectiveSupervisorExit = supervisorExit ?? exit
  const preLaunchInterrupt = !workerStarted && exit === null && Boolean(outerSignal) && !stopError && !unconfirmedStop && !escalatedStop
  const spawnError = exit?.error ?? (!workerStarted && exit && exit.code !== 86
    ? new Error(`Owned worker did not start (supervisor exit code=${exit.code}, signal=${exit.signal})`)
    : null)
  const supervisorStatusOnly = Boolean(
    spawnError || escalatedStop || unconfirmedStop || stopError || exit?.code === 86 || effectiveSupervisorExit?.code === 86 || exit?.signal || effectiveSupervisorExit?.signal || preLaunchInterrupt,
  )
  const workerExited = exit !== null && !supervisorStatusOnly && exit.signal === null
  const workerExitCode = workerExited ? exit.code : null
  const workerExitSignal = null
  const workerCode = workerExited ? (exit.code ?? 1) : null
  const supervisorFailed = !workerExited || workerCode !== 0 || Boolean(exit?.signal) || Boolean(spawnError) || Boolean(stopError) || escalatedStop
  const interrupted = outerSignal ?? proof?.interruptedSignal ?? effectiveSupervisorExit?.signal ?? (workerCode === 130 ? 'SIGINT' : workerCode === 143 ? 'SIGTERM' : null)
  const finalResult = proof?.result === 0 && !supervisorFailed && !interrupted ? 0 : 1
  const workerStopError = stopError
    ? String(stopError?.message ?? stopError)
    : preLaunchInterrupt || spawnError
      ? undefined
      : !workerExited
        ? (exit?.code === 86 || effectiveSupervisorExit?.code === 86
          ? 'Fixture supervisor reported incomplete child tree termination'
          : escalatedStop
            ? 'Owned worker did not exit within grace period; supervisor forced termination'
            : 'Owned worker exit was not confirmed after stop')
        : undefined
  const includeSupervisorStatus = supervisorStatusOnly && !preLaunchInterrupt && effectiveSupervisorExit !== null
    && (effectiveSupervisorExit.code !== null || effectiveSupervisorExit.signal !== null)
  return {
    workerExited,
    workerCode,
    supervisorFailed,
    interrupted,
    finalResult,
    workerExitCode,
    workerExitSignal,
    ...(escalatedStop ? { workerStopEscalated: true } : {}),
    ...(includeSupervisorStatus ? {
      supervisorExitCode: effectiveSupervisorExit.code ?? null,
      supervisorExitSignal: effectiveSupervisorExit.signal ?? null,
    } : {}),
    ...(workerStopError ? { workerStopError } : {}),
    ...(spawnError ? { workerSpawnError: String(spawnError?.message ?? spawnError) } : {}),
  }
}

export function publishWorkerProof({ workerProfile, exit, workerStarted, escalatedStop = false, unconfirmedStop = false, stopError = null, outerSignal = null, supervisorExit = null }) {
  assert.equal(typeof workerStarted, 'boolean', 'workerStarted must be a boolean')
  const workerProofFile = path.join(workerProfile, 'proof.worker.json.tmp')
  const supervisorProofTmp = path.join(workerProfile, 'proof.supervisor.json.tmp')
  const proofFile = path.join(workerProfile, 'proof.json')
  let proof
  try { proof = JSON.parse(readFileSync(workerProofFile, 'utf8')) } catch {}
  const verdict = evaluateWorkerExit({ exit, workerStarted, escalatedStop, unconfirmedStop, stopError, outerSignal, proof, supervisorExit })
  const {
    workerExited,
    interrupted,
    finalResult,
    workerExitCode,
    workerExitSignal,
    workerStopEscalated,
    supervisorExitCode,
    supervisorExitSignal,
    workerStopError,
    workerSpawnError,
  } = verdict
  const finalProof = {
    ...(proof ?? { profile: workerProfile }),
    result: finalResult,
    interruptedSignal: interrupted,
    workerExited,
    workerExitCode,
    workerExitSignal,
    ...(workerStopEscalated ? { workerStopEscalated } : {}),
    ...(supervisorExitCode !== undefined ? { supervisorExitCode } : {}),
    ...(supervisorExitSignal !== undefined ? { supervisorExitSignal } : {}),
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
