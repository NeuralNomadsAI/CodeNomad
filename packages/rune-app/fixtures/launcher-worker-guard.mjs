export function needsOwnedWindowsWorker(argv, platform = process.platform) {
  if (platform !== 'win32' || argv.includes('--owned-mobile-worker')) return false
  return argv.includes('--web-android')
    || argv.includes('--web-mobile-more-actions')
    || argv.includes('--web-mobile')
    || argv.includes('--web-keyboard-viewport')
    || argv.includes('--web-mobile-drawers')
    || argv.includes('--web-sse-7tabs')
}

export function evaluateWorkerExit({ exit, unconfirmedStop = false, stopError = null, outerSignal = null, proof = null }) {
  const spawnError = exit?.error ?? null
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
