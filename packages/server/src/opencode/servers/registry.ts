import { OpenCodeServersSchema, ProjectExecutionBindingSchema } from "../../config/schema"
import { LOCAL_SHARED_SERVER_ID, type OpenCodeServerProfile, type OpenCodeServerSummary } from "./types"

const local: OpenCodeServerProfile = Object.freeze({ kind: "local-shared", id: LOCAL_SHARED_SERVER_ID })

/** Metadata only. SettingsService supplies the owning document's private writer. */
export class OpenCodeServerRegistry {
  #beforeChange = new Set<(next: OpenCodeServerProfile[]) => void>()
  constructor(private readonly read: () => unknown, private readonly write: (profiles: OpenCodeServerProfile[]) => void) {}

  list(): OpenCodeServerProfile[] {
    const value = this.read()
    const profiles = OpenCodeServersSchema.parse(value === undefined ? [] : value)
    return [local, ...profiles.filter(profile => profile.kind !== "local-shared")]
  }

  get(id: string): OpenCodeServerProfile | undefined {
    return this.list().find(profile => profile.id === id)
  }

  replace(value: unknown): void {
    const next = OpenCodeServersSchema.parse(value)
    for (const listener of this.#beforeChange) listener(next)
    this.write(next)
  }

  beforeChange(listener: (next: OpenCodeServerProfile[]) => void): () => void {
    this.#beforeChange.add(listener)
    return () => { this.#beforeChange.delete(listener) }
  }
}

/** Preserve unknown target IDs for repair; remote directories remain byte-for-byte opaque. */
export function parseProjectExecutionBinding(value: unknown) {
  return ProjectExecutionBindingSchema.parse(value)
}

/** Whitelist fields even when an on-disk entry contains unexpected secret material. */
export function summarizeOpenCodeServers(value: unknown): OpenCodeServerSummary[] {
  const result: OpenCodeServerSummary[] = [{ kind: "local-shared", id: LOCAL_SHARED_SERVER_ID }]
  if (!Array.isArray(value)) return result
  const ids = new Set<string>([LOCAL_SHARED_SERVER_ID])
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || entry.kind !== "explicit") continue
    const { id, kind, label, origin } = entry
    const parsed = OpenCodeServersSchema.safeParse([{ id, kind, label, origin }])
    if (!parsed.success || ids.has(id)) continue
    const profile = parsed.data[0]!
    if (profile.kind !== "explicit") continue
    ids.add(id)
    result.push({ id: profile.id, kind: profile.kind, label: profile.label, origin: profile.origin,
      hasCredentials: false, needsCredentials: true })
  }
  return result
}
