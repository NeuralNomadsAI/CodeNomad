import { setupMissionsPlugin } from "../../packages/server/src/opencode/missions-plugin"

// Test the existing shared product, not the earlier integration_* tools or a
// parallel journal. Explicitly loaded only in the private native test server.
// No CodeNomad presence/HTTP transport, no invented durable-host qualification.
export default {
  id: "codenomad.missions",
  setup: setupMissionsPlugin,
}
