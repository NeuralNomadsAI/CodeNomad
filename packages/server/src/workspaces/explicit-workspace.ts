import { OpenCode, type LocationRef, type OpenCodeClient } from "@opencode/client"
import { FileSystem } from "@opencode/schema/filesystem"
import { Schema } from "effect"
import type { OpenCodeServerConnections, ServerConnection, ServerProjectLease } from "../opencode/servers/connections"
import { initialServerCapabilities, requireServerCapability, type ServerCapability } from "../opencode/servers/capabilities"
import type { ProjectExecutionBinding } from "../opencode/servers/types"
import type { ServiceConnection } from "./opencode-service"
import { readLocationRef } from "../opencode/compatibility/location"

const isNativeListing = Schema.is(Schema.Array(FileSystem.Entry))

export class ExplicitWorkspaceError extends Error {
  constructor(readonly code: "explicit_open_not_ready" | "explicit_location_unavailable" | "explicit_capability_unavailable") {
    super(code)
    this.name = "ExplicitWorkspaceError"
  }
}

/** One logical occurrence: no host paths, environment, discovery or session mutations. */
export class ExplicitWorkspace {
  readonly binding: Readonly<ProjectExecutionBinding>
  readonly #lease: ServerProjectLease
  #released = false
  #connection?: ServiceConnection

  constructor(private readonly connections: OpenCodeServerConnections, binding: ProjectExecutionBinding) {
    if (!binding.serverId || binding.serverId === "local-shared" || !binding.directory || binding.directory.includes("\0")) {
      throw new ExplicitWorkspaceError("explicit_location_unavailable")
    }
    this.binding = Object.freeze({ serverId: binding.serverId, directory: binding.directory })
    // Retain before any asynchronous admission/validation; this also spans publication.
    this.#lease = connections.retainProject(this.binding)
  }

  async validate(signal: AbortSignal) {
    const connection = await this.#lease.acquire()
    this.assertCurrent(connection, signal)
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
    // Bound native location and readability proof, including the response body. A listing
    // is only an attachment proof; it grants no Files capability or directory descendants.
    const client = OpenCode.make({ baseUrl: connection.endpoint.url, fetch: async (input, init) => {
      this.assertCurrent(connection, lifetime)
      const response = await connection.fetch(input, { ...init, signal: lifetime })
      const reader = response.body?.getReader()
      if (!reader) throw new ExplicitWorkspaceError("explicit_location_unavailable")
      let length = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const chunk = await reader.read()
          this.assertCurrent(connection, lifetime)
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > 8 * 1024 * 1024) throw new ExplicitWorkspaceError("explicit_location_unavailable")
          chunks.push(chunk.value)
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
      return new Response(Buffer.concat(chunks, length), { status: response.status, headers: response.headers })
    } })
    try {
      const location = await client.location.get({ location: { directory: this.binding.directory } }, { signal: lifetime })
      this.assertCurrent(connection, lifetime)
      if (location.directory !== this.binding.directory || readLocationRef(location).workspaceID !== undefined
        || typeof location.project?.id !== "string" || !location.project.id) throw new ExplicitWorkspaceError("explicit_location_unavailable")
      const listing = await client.file.list({ location: { directory: this.binding.directory }, path: "." }, { signal: lifetime })
      this.assertCurrent(connection, lifetime)
      if (listing.location.directory !== this.binding.directory || readLocationRef(listing.location).workspaceID !== undefined
        || !isNativeListing(listing.data)) throw new ExplicitWorkspaceError("explicit_location_unavailable")
      this.#connection = connection
      return { directory: this.binding.directory }
    } catch {
      this.assertCurrent(connection, signal)
      throw new ExplicitWorkspaceError("explicit_location_unavailable")
    }
  }

  capabilities() {
    // The connection owner publishes only negotiated connections. Inspect it without
    // acquisition: pending, failed and revoked connections confer no authority.
    let connection: ServerConnection | undefined
    if (!this.#released) {
      try { connection = this.connections.existingForServer(this.binding.serverId) as ServerConnection | undefined }
      catch { /* A superseded connection leaves an unverified display snapshot. */ }
    }
    const capabilities = initialServerCapabilities({ id: this.binding.serverId, kind: "explicit", label: this.binding.serverId,
      origin: connection?.endpoint.url ?? "" }, connection?.generation ?? 0)
    if (connection) {
      // prototype-1236: read-only Files/Changes, background shells, Yolo, published quotas and plugin inventory, all native.
      for (const feature of ["sessions", "chat", "media", "permissions", "questions", "events",
        "files", "git", "backgroundShells", "yolo", "providerUsage", "plugins"] as const) {
        capabilities.features[feature] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
      }
    }
    return capabilities
  }

  requireCapability(capability: ServerCapability) {
    if (this.#released || !this.#connection) throw new ExplicitWorkspaceError("explicit_location_unavailable")
    // Private current-connection policy owns admission; descriptors are snapshots.
    requireServerCapability(capability, this.capabilities().features[capability])
  }

  async acquire() {
    const connection = await this.connections.acquireForWorkspace(this.binding)
    this.assertCurrent(connection)
    return connection
  }

  ownsLocation(location: LocationRef, connection: ServiceConnection, client?: OpenCodeClient): boolean {
    this.assertCurrent(connection)
    return (!client || client === connection.client) && location.workspaceID === undefined && location.directory === this.binding.directory
  }

  async ownsSession(sessionID: string) {
    const connection = await this.acquire()
    const session = await connection.client.session.get({ sessionID })
    this.assertCurrent(connection)
    return session?.id === sessionID && Boolean(session.location) && this.ownsLocation(session.location, connection)
  }

  assertCurrent(connection = this.#connection, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.#released) throw new ExplicitWorkspaceError("explicit_location_unavailable")
    if (connection && (connection as ServerConnection).serverId !== this.binding.serverId) throw new ExplicitWorkspaceError("explicit_location_unavailable")
    connection?.assertCurrent()
  }

  release() {
    if (this.#released) return
    this.#released = true
    this.#lease.release()
  }

  published(instanceId: string) { this.#lease.published(instanceId) }
}
