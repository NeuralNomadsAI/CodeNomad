# Server Conventions

## Framework: Fastify

- Routes registered in `packages/server/src/server/routes/`
- Route handlers typed with Fastify generics
- Dependencies injected via `RouteDeps` interfaces

### Route Registration Pattern

```typescript
// packages/server/src/server/routes/example.ts
interface RouteDeps {
  exampleManager: ExampleManager
}

function registerExampleRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/examples", async () => {
    return deps.exampleManager.list()
  })
}
```

## API Types

- **Shared types:** `packages/server/src/api-types.ts`
- **Consumed by UI:** `packages/ui/src/types/`
- **Breaking change rule:** Changing a type requires checking UI for matching interfaces
- **Preferred approach:** Additive changes (new optional fields) over breaking changes

### Type Sharing Pattern

```typescript
// Server defines in api-types.ts
export interface ExampleResponse {
  id: string
  name: string
}

// UI may extend or mirror in packages/ui/src/types/
export type { ExampleResponse } from "../../../server/src/api-types"
```

## Configuration

- **Settings service:** `packages/server/src/settings/service.ts`
- **YAML document store:** `packages/server/src/settings/yaml-doc-store.ts`
- **Public config sanitization:** `packages/server/src/settings/public-config.ts`
- **Config location resolution:** `packages/server/src/config/location.ts`

### Settings Documents

| Document | Purpose | File |
|----------|---------|------|
| Config | User preferences, binaries, models | `~/.config/codenomad/config.json` |
| State | Recent folders, session metadata | `~/.config/codenomad/state.json` |

## Testing

- **Route tests:** Fastify inject in `__tests__/` subdirectories
- **Example:** `packages/server/src/server/__tests__/network-addresses.test.ts`
- **No integration tests** for external services

### Route Test Pattern

```typescript
// packages/server/src/server/routes/__tests__/example.test.ts
import { createApp } from "./helpers"

test("GET /api/examples", async () => {
  const app = createApp()
  const response = await app.inject({
    method: "GET",
    url: "/api/examples"
  })
  expect(response.statusCode).toBe(200)
})
```

## Background Processes

- **Manager:** `packages/server/src/background-processes/manager.ts`
- **Spawned via:** `spawn` with persistent output tracking
- **Output streaming:** SSE events for real-time UI updates
- **Process lifecycle:** start → running → stop/error

## Workspaces

- **Workspace manager:** `packages/server/src/workspaces/manager.ts`
- **Runtime:** `packages/server/src/workspaces/runtime.ts`
- **Git worktrees:** `packages/server/src/workspaces/git-worktrees.ts`
- **Spawn spec:** `packages/server/src/workspaces/spawn.ts`

### Workspace Lifecycle

1. Create workspace (folder path)
2. Spawn OpenCode server process
3. Manage via workspace runtime
4. Clean up on delete

## Authentication

- **Auth manager:** `packages/server/src/auth/manager.ts`
- **Session manager:** `packages/server/src/auth/session-manager.ts`
- **Token manager:** `packages/server/src/auth/token-manager.ts`
- **Password hashing:** `packages/server/src/auth/password-hash.ts`

### Auth Flow

1. Server generates bootstrap token on startup
2. UI exchanges token for session cookie
3. Subsequent requests use session cookie
4. Credentials stored in auth file (hashed with scrypt)
