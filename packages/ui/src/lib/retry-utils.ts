interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  timeoutMs?: number
  shouldRetry?: (error: Error, attempt: number) => boolean
  wait?: (delayMs: number) => Promise<void>
}

export async function retryWithBackoff<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
    timeoutMs,
    shouldRetry = () => true,
    wait = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = options

  let lastError: Error | null = null
  let delayMs = initialDelayMs

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (timeoutMs) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const result = await fn(controller.signal)
          clearTimeout(timer)
          return result
        } catch (error) {
          clearTimeout(timer)
          throw error
        }
      }

      return await fn()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      lastError = err

      if (attempt < maxAttempts && shouldRetry(err, attempt)) {
        await wait(delayMs)
        delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs)
      } else {
        throw err
      }
    }
  }

  throw lastError || new Error("Failed after retries")
}

export function isRetryableError(error: Error): boolean {
  if (error.name === "AbortError" || error.name === "TimeoutError") return true
  if (error.message.includes("Failed to fetch")) return true
  if (error.message.includes("NetworkError")) return true
  if (error.message.includes("timeout")) return true
  return false
}
