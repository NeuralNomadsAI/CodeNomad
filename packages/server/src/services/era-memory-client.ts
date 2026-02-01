/**
 * Era Memory API Client
 *
 * TypeScript client for the Era Memory service. Handles CRUD operations
 * on memories with retry logic and graceful degradation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Memory {
  id: string
  content: string
  type: "preference" | "semantic_knowledge" | "episodic" | "procedural"
  metadata?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface MemoryCreateRequest {
  content: string
  type: Memory["type"]
  metadata?: Record<string, unknown>
}

export interface MemorySearchRequest {
  query: string
  type?: Memory["type"]
  limit?: number
  minScore?: number
}

export interface MemorySearchResult {
  memory: Memory
  score: number
}

export interface EraMemoryClientConfig {
  baseUrl: string
  apiKey?: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  maxRetries: number
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

export function getDefaultConfig(): EraMemoryClientConfig {
  return {
    baseUrl: process.env.ERA_MEMORY_URL ?? "http://localhost:8000",
    apiKey: process.env.ERA_MEMORY_API_KEY,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    maxRetries: 2,
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EraMemoryClient {
  private config: EraMemoryClientConfig

  constructor(config?: Partial<EraMemoryClientConfig>) {
    this.config = { ...getDefaultConfig(), ...config }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.config.apiKey) {
      h["Authorization"] = `Bearer ${this.config.apiKey}`
    }
    return h
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retries = this.config.maxRetries,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs)

    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        const err = new Error(`Era Memory API ${method} ${path}: ${resp.status} ${text}`)
        // Only retry on 5xx
        if (resp.status >= 500 && retries > 0) {
          const delay = (this.config.maxRetries - retries + 1) * 500
          await new Promise((r) => setTimeout(r, delay))
          return this.request<T>(method, path, body, retries - 1)
        }
        throw err
      }

      return (await resp.json()) as T
    } catch (err) {
      if (retries > 0 && err instanceof Error && err.name === "AbortError") {
        const delay = (this.config.maxRetries - retries + 1) * 500
        await new Promise((r) => setTimeout(r, delay))
        return this.request<T>(method, path, body, retries - 1)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  // --- CRUD ---

  async create(req: MemoryCreateRequest): Promise<Memory> {
    return this.request<Memory>("POST", "/api/memories", req)
  }

  async search(req: MemorySearchRequest): Promise<MemorySearchResult[]> {
    return this.request<MemorySearchResult[]>("POST", "/api/memories/search", req)
  }

  async batchCreate(items: MemoryCreateRequest[]): Promise<Memory[]> {
    return this.request<Memory[]>("POST", "/api/memories/batch", { items })
  }

  async update(id: string, patch: Partial<MemoryCreateRequest>): Promise<Memory> {
    return this.request<Memory>("PATCH", `/api/memories/${id}`, patch)
  }

  async delete(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/memories/${id}`)
  }

  // --- Health Check ---

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.connectTimeoutMs)
      try {
        const resp = await fetch(`${this.config.baseUrl}/health`, {
          signal: controller.signal,
        })
        return resp.ok
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      return false
    }
  }
}
