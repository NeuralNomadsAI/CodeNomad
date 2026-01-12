import type { FastifyInstance } from "fastify"
import { fetch } from "undici"

const MODELS_API_URL = "https://models.dev/api.json"
const LOGO_BASE_URL = "https://models.dev/logos"
const CACHE_DURATION_MS = 30 * 60 * 1000 // 30 minutes

interface CacheEntry<T> {
  data: T
  timestamp: number
}

let modelsCache: CacheEntry<unknown> | null = null
const logoCache = new Map<string, CacheEntry<Buffer>>()

export function registerModelsProxyRoutes(app: FastifyInstance) {
  // Proxy models.dev API data with caching
  app.get("/api/models/data", async (_request, reply) => {
    try {
      // Check cache
      if (modelsCache && Date.now() - modelsCache.timestamp < CACHE_DURATION_MS) {
        return reply.header("X-Cache", "HIT").send(modelsCache.data)
      }

      // Fetch from models.dev
      const response = await fetch(MODELS_API_URL, {
        headers: {
          "User-Agent": "EraCode/1.0",
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`)
      }

      const data = await response.json()

      // Update cache
      modelsCache = {
        data,
        timestamp: Date.now(),
      }

      return reply.header("X-Cache", "MISS").send(data)
    } catch (error) {
      // Return cached data if available, even if stale
      if (modelsCache) {
        return reply
          .header("X-Cache", "STALE")
          .header("X-Cache-Error", String(error))
          .send(modelsCache.data)
      }

      reply.code(502).send({
        error: "Failed to fetch models data",
        message: error instanceof Error ? error.message : "Unknown error",
      })
    }
  })

  // Proxy provider logos with caching
  app.get<{ Params: { provider: string } }>("/api/models/logo/:provider", async (request, reply) => {
    const { provider } = request.params
    const cacheKey = provider

    try {
      // Check cache
      const cached = logoCache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
        return reply
          .header("Content-Type", "image/svg+xml")
          .header("X-Cache", "HIT")
          .header("Cache-Control", "public, max-age=1800")
          .send(cached.data)
      }

      // Fetch logo from models.dev
      const logoUrl = `${LOGO_BASE_URL}/${encodeURIComponent(provider)}.svg`
      const response = await fetch(logoUrl, {
        headers: {
          "User-Agent": "EraCode/1.0",
        },
      })

      if (!response.ok) {
        // Return a placeholder SVG for missing logos
        const placeholder = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><text x="12" y="16" text-anchor="middle" font-size="10" fill="currentColor">${provider.charAt(0).toUpperCase()}</text></svg>`
        )
        return reply
          .header("Content-Type", "image/svg+xml")
          .header("X-Cache", "PLACEHOLDER")
          .send(placeholder)
      }

      const buffer = Buffer.from(await response.arrayBuffer())

      // Update cache
      logoCache.set(cacheKey, {
        data: buffer,
        timestamp: Date.now(),
      })

      // Limit cache size
      if (logoCache.size > 100) {
        const oldest = Array.from(logoCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
        if (oldest) {
          logoCache.delete(oldest[0])
        }
      }

      return reply
        .header("Content-Type", "image/svg+xml")
        .header("X-Cache", "MISS")
        .header("Cache-Control", "public, max-age=1800")
        .send(buffer)
    } catch (error) {
      // Return cached logo if available
      const cached = logoCache.get(cacheKey)
      if (cached) {
        return reply
          .header("Content-Type", "image/svg+xml")
          .header("X-Cache", "STALE")
          .send(cached.data)
      }

      // Return placeholder on error
      const placeholder = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`
      )
      return reply.header("Content-Type", "image/svg+xml").send(placeholder)
    }
  })

  // Cache status endpoint for debugging
  app.get("/api/models/cache-status", async (_request, reply) => {
    return reply.send({
      modelsCache: modelsCache
        ? {
            cached: true,
            age: Date.now() - modelsCache.timestamp,
            maxAge: CACHE_DURATION_MS,
          }
        : { cached: false },
      logoCache: {
        size: logoCache.size,
        providers: Array.from(logoCache.keys()),
      },
    })
  })
}
