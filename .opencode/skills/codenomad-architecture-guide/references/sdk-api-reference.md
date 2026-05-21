# SDK API Reference

## Overview

CodeNomad uses the OpenCode SDK V2 (`@opencode-ai/sdk/v2/client`) via `createOpencodeClient()`.

**⚠️ REQUIRED:** Before relying on any schema detail here, verify by reading:
`packages/sdk/js/src/v2/gen/types.gen.ts`

## SDK Categories Used by CodeNomad

### Session

**SDK:** `client.session.prompt({ sessionID, content, command?, agent? })`
**Wrapper:** `packages/ui/src/stores/session-api.ts`
```typescript
const response = await requestData(
  client.session.prompt({ sessionID, content }),
  "session.prompt"
)
```
**Returns:** `{ data, error }` — always check `error` first

**Other Session Methods:**
- `client.session.list()` — List all sessions
- `client.session.create({ parentID? })` — Create new session
- `client.session.get({ sessionID })` — Get session info
- `client.session.delete({ sessionID })` — Delete session
- `client.session.children({ sessionID })` — Get child sessions
- `client.session.diff({ sessionID })` — Get file changes
- `client.session.revert({ sessionID, messageID? })` — Revert code
- `client.session.unrevert({ sessionID })` — Unrevert
- `client.session.messages({ sessionID })` — List messages
- `client.session.message({ sessionID, messageID })` — Get single message
- `client.session.deleteMessage({ sessionID, messageID })` — Delete message

### Part (Critical — Schema Constraints)

**SDK:** `client.session.message.part.update({ sessionID, messageID, partID, data })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts:updateMessagePart()`

**⚠️ Schema Requirements:**
- Must spread existing part fields
- Assistant part metadata → `providerMetadata` (must be `Record<providerName, Record<string, any>>`)
- Flat objects like `{ compacted: true }` cause fatal schema errors

**SDK:** `client.session.message.part.delete({ sessionID, messageID, partID })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts`

**⚠️ Constraint:** Message must retain ≥1 part. Delete entire message if removing last part.

### Permission

**SDK:** `client.permission.reply({ requestID, reply: "allow" | "deny" | "once" })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts:sendPermissionResponse()`

**Other Permission Methods:**
- `client.permission.list()` — Get pending permissions

### Question

**SDK:** `client.question.reply({ requestID, answer: string[] })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts`

**Other Question Methods:**
- `client.question.list()` — Get pending questions
- `client.question.reject({ requestID })` — Reject question

### File

**SDK:** Direct SDK calls via worktree client
- `client.file.list({ path })` — List directory
- `client.file.read({ path })` — Read file content
- `client.file.status({ path })` — Get Git status

### Find

**SDK:** Direct SDK calls
- `client.find.text({ query })` — Search file contents
- `client.find.files({ query })` — Search filenames
- `client.find.symbols({ query })` — Search workspace symbols

### Config

**SDK:**
- `client.config.get()` — Get current config
- `client.config.update({ ... })` — Update config
- `client.config.providers()` — List AI providers

**Wrapper:** `packages/ui/src/stores/preferences.tsx`

### Global

**SDK:**
- `client.global.config.get()` — Get global config
- `client.global.health()` — Health check

**Wrapper:** `packages/ui/src/lib/server-meta.ts`

### App

**SDK:**
- `client.app.log({ level, message })` — Write log entry
- `client.app.agents()` — List available agents

**Wrapper:** Background process logging

### Worktree

**SDK:**
- `client.worktree.list()` — List worktrees
- `client.worktree.create({ slug, branch? })` — Create worktree
- `client.worktree.remove({ slug })` — Remove worktree

**Wrapper:** `packages/ui/src/stores/worktrees.ts`
