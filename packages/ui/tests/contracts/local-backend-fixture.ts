import type { TestContext } from "node:test"
import { backends, localBackend, type BackendClient } from "../../src/lib/backend-client"

/** Lifetime tests inject IO into local singletons; register that transport for their synthetic owner. */
export function registerLocalBackendFixture(t: TestContext, id: string) {
  const registry = backends as Map<string, BackendClient>
  if (registry.has(id)) return
  const backend = { ...localBackend, id }
  registry.set(id, backend)
  t.after(() => {
    if (registry.get(id) === backend) registry.delete(id)
  })
}
