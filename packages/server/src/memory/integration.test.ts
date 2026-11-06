import { describe } from "node:test"

// One runner owns the real Git/process integrations, even in the full server glob.
// Keep the imported cases serial; individual cases explicitly control contention.
describe("memory integrations", { concurrency: 1 }, async () => {
  await import("./rules.integration")
  await import("./project-identity.integration")
  await import("./lock.integration")
  await import("../server/routes/memory.integration")
  await import("./store.integration")
})
