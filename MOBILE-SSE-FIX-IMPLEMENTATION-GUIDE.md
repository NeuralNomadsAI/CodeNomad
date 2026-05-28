# Mobile SSE Resilience Fix - Implementation Guide

**Reference:** See `MOBILE-SSE-RESILIENCE-ANALYSIS.md` for root cause details

## Implementation: Option A (Pong Retry Logic)

This guide provides step-by-step instructions for implementing retry logic on the pong HTTP POST.

### Changes Required

#### 1. Create Utility: Retry Helper with Exponential Backoff

**File:** `packages/ui/src/lib/retry-utils.ts` (new)

```typescript
interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
  } = options

  let lastError: Error | null = null
  let delayMs = initialDelayMs

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs)
      }
    }
  }

  throw new Error(
    `Failed after ${maxAttempts} attempts: ${lastError?.message || "Unknown error"}`,
  )
}
```

#### 2. Update Server Events Pong Handler

**File:** `packages/ui/src/lib/server-events.ts`

**Change at line 47-56:**

```typescript
// BEFORE
(payload) => {
  void serverApi
    .sendClientConnectionPong({
      ...getClientIdentity(),
      pingTs: payload.ts,
    })
    .catch(() => {
      debugWarn("sse", "Pong failed (connection already closed)")
    })
}

// AFTER
(payload) => {
  const identity = getClientIdentity()
  const pongPayload = { ...identity, pingTs: payload.ts }
  
  void retryWithBackoff(
    () => serverApi.sendClientConnectionPong(pongPayload),
    {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 2000,
    }
  )
    .catch((error) => {
      debugWarn("sse", `Pong failed after retries: ${error.message}`)
    })
}
```

**Also add import at top:**
```typescript
import { retryWithBackoff } from "./retry-utils"
```

#### 3. Add Logging for Observability

**File:** `packages/ui/src/lib/server-events.ts`

Enhance the pong handler to log retry attempts:

```typescript
(payload) => {
  const identity = getClientIdentity()
  const pongPayload = { ...identity, pingTs: payload.ts }
  let attemptCount = 0
  
  void retryWithBackoff(
    async () => {
      attemptCount++
      if (attemptCount > 1) {
        logSse(`Pong retry attempt ${attemptCount}`)
      }
      return serverApi.sendClientConnectionPong(pongPayload)
    },
    {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 2000,
    }
  )
    .catch((error) => {
      debugWarn("sse", `Pong failed: ${error.message}`)
      // Optionally trigger reconnect if pong fails completely
      // scheduleReconnect()
    })
}
```

### Testing Checklist

#### Unit Tests

**File:** `packages/ui/src/lib/retry-utils.test.ts` (new)

```typescript
import { describe, it, expect, vi } from "vitest"
import { retryWithBackoff } from "./retry-utils"

describe("retryWithBackoff", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("success")
    const result = await retryWithBackoff(fn)
    expect(result).toBe("success")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("success")
    const result = await retryWithBackoff(fn)
    expect(result).toBe("success")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("fails after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"))
    await expect(retryWithBackoff(fn, { maxAttempts: 2 })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("respects backoff delays", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"))
    const startTime = Date.now()
    
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
      })
    ).rejects.toThrow()

    const elapsed = Date.now() - startTime
    // 50ms + 100ms = 150ms minimum (plus jitter)
    expect(elapsed).toBeGreaterThanOrEqual(150)
  })
})
```

#### Integration Tests

**File:** `packages/ui/src/lib/server-events.test.ts` (update existing)

Add test for pong retry on network failure:

```typescript
it("retries pong on transient network failure", async () => {
  const mockApi = {
    sendClientConnectionPong: vi
      .fn()
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValue(undefined),
  }

  // Trigger ping handler
  const pingPayload = { ts: Date.now() }
  await pingHandler(pingPayload) // Assuming handler is extracted

  // Verify retry logic was invoked
  await vi.advanceTimersByTimeAsync(100)
  expect(mockApi.sendClientConnectionPong).toHaveBeenCalledTimes(2)
})
```

#### Manual Testing

1. **Throttle Network (DevTools → Network → 3G)**
   - Send message
   - Verify response arrives (no "Abort" button needed)
   - Check console for `Pong retry attempt` logs

2. **Intermittent Connectivity**
   - Use network simulator
   - Create 500ms packet loss window during pong
   - Verify retry succeeds after loss ends

3. **Multiple Messages**
   - Send 5 messages rapidly
   - Verify all receive responses (with retries in logs)
   - No dropped messages

### Metrics to Monitor

Add to server logs for post-deployment monitoring:

**File:** `packages/server/src/server/routes/events.ts`

Track pong success/failure rate:

```typescript
interface PongStats {
  totalPings: number
  successfulPongs: number
  failedPongs: number
}

const stats = new Map<string, PongStats>()

app.post("/api/client-connections/pong", (request, reply) => {
  const body = PongBodySchema.parse(request.body ?? {})
  if (!deps.connectionManager.pong(body)) {
    // Track failed pongs
    stats.set(body.clientId, {
      ...stats.get(body.clientId),
      failedPongs: (stats.get(body.clientId)?.failedPongs ?? 0) + 1,
    })
    reply.code(404).send({ error: "Client connection not found" })
    return
  }
  
  // Track successful pongs
  stats.set(body.clientId, {
    ...stats.get(body.clientId),
    successfulPongs: (stats.get(body.clientId)?.successfulPongs ?? 0) + 1,
  })
  reply.code(204).send()
})
```

### Success Criteria

- ✓ No console errors for pong failures on 3G network
- ✓ Messages received responses within 5 seconds (including retry time)
- ✓ No "Abort" button needed for messages sent on poor networks
- ✓ Retry logs show 1-2 retries on slow connections
- ✓ Unit tests pass (100% coverage of retry-utils)
- ✓ Integration tests pass (pong retry scenarios)

### Rollback Plan

If issues appear post-deployment:
1. Reduce `maxAttempts` from 3 to 2
2. Increase `initialDelayMs` from 100ms to 200ms
3. Revert to previous version if retry logic causes new issues

### Next Steps After Option A

If retry logic doesn't fully solve mobile issues:
1. Monitor metrics for pong failure patterns
2. Identify if failures are permanent or transient
3. Consider escalating to Option B (SSE-based pong)

See `MOBILE-SSE-RESILIENCE-ANALYSIS.md` for Option B details.
