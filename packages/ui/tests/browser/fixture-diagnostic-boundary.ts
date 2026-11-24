export async function runWithDiagnosticCleanup<T>(options: {
  run: () => Promise<T>
  diagnose: () => Promise<void>
  cleanup: () => Promise<void>
  onObservationError: (error: unknown) => void
  onCleanupError: (error: unknown) => void
}): Promise<T> {
  let primaryFailed = false
  try {
    try {
      return await options.run()
    } catch (error) {
      primaryFailed = true
      try {
        await options.diagnose()
      } catch (observationError) {
        try { options.onObservationError(observationError) } catch {}
      }
      throw error
    }
  } finally {
    try {
      await options.cleanup()
    } catch (cleanupError) {
      if (!primaryFailed) throw cleanupError
      try { options.onCleanupError(cleanupError) } catch {}
    }
  }
}
