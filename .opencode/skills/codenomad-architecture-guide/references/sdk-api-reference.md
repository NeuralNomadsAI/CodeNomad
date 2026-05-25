# SDK API Reference

## Overview

CodeNomad uses the OpenCode SDK V2 (`@opencode-ai/sdk/v2/client`) via `createOpencodeClient()`.

**Note:** The SDK implementation lives outside this repository.

- After `npm install`, inspect types in `node_modules/@opencode-ai/sdk/v2/client.d.ts`
- **Fallback:** Use the CodeNomad wrapper locations documented below as the source of truth
- When node_modules is unavailable, read how the SDK is imported in existing files

## SDK Methods Used by CodeNomad

### Session

**SDK:** `client.session.promptAsync({ sessionID, content, command?, agent? })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts`
```typescript
const response = await requestData(
  client.session.promptAsync({ sessionID, content }),
  "session.promptAsync"
)
```

**Other Session Methods Used:**
- `client.session.list()` — List all sessions
- `client.session.create({ parentID? })` — Create new session
- `client.session.get({ sessionID })` — Get session info
- `client.session.delete({ sessionID })` — Delete session
- `client.session.children({ sessionID })` — Get child sessions
- `client.session.diff({ sessionID })` — Get file changes
- `client.session.revert({ sessionID, messageID? })` — Revert code
- `client.session.summarize({ sessionID })` — Generate summary
- `client.session.messages({ sessionID })` — List messages
- `client.session.update({ sessionID, ... })` — Update session properties
- `client.session.command({ sessionID, command })` — Send command
- `client.session.shell({ sessionID, command })` — Execute shell command
- `client.session.abort({ sessionID })` — Abort active session

**Note on Message Deletion:** The SDK does not expose a typed method for message deletion. CodeNomad uses a raw client call:
```typescript
// packages/ui/src/stores/session-actions.ts:451-457
await requestData(
  (client as any).client.delete({
    url: `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
  }),
  "session.message.delete",
)
```

### Part

**SDK:** `client.part.delete({ sessionID, messageID, partID })`
**Wrapper:** `packages/ui/src/stores/session-actions.ts:deleteMessagePart()`
```typescript
await requestData(
  client.part.delete({ sessionID: sessionId, messageID: messageId, partID: partId }),
  "part.delete",
)
```

**⚠️ Constraint:** Message must retain ≥1 part. Delete entire message if removing last part.

**Note on Part Updates:** CodeNomad does not currently use `client.part.update()`. Part modifications are handled through other mechanisms.

### Permission

**SDK:** `client.permission.reply({ requestID, reply: "allow" | "deny" | "once" })`
**Wrapper:** `packages/ui/src/stores/instances.ts:sendPermissionResponse()`

**Other Permission Methods:**
- `client.permission.list()` — Get pending permissions

### Question

**SDK:** `client.question.reply({ requestID, answers: string[][] })`
**Wrapper:** `packages/ui/src/stores/instances.ts:sendQuestionReply()`

**Other Question Methods:**
- `client.question.list()` — Get pending questions
- `client.question.reject({ requestID })` — Reject question

### File

**SDK:** `client.file.list({ path })` — List directory contents
**Wrapper:** `packages/ui/src/components/instance/shell/right-panel/RightPanel.tsx`

**SDK:** `client.file.read({ path })` — Read file content
**Wrapper:** `packages/ui/src/components/instance/shell/right-panel/RightPanel.tsx`

**SDK:** `client.file.status()` — Get Git status of files
**Wrapper:** `packages/ui/src/components/instance/shell/right-panel/useGitChanges.ts`

### Config

**SDK:** `client.config.get()` — Get current configuration
**Wrapper:** `packages/ui/src/lib/hooks/use-instance-metadata.ts`

**Note:** `client.config.update()` and `client.config.providers()` are available but configuration updates flow through server routes instead.

## SDK Categories Not Currently Used

The following SDK categories are available but not actively used by CodeNomad:

- `client.find.*` — File/symbol search (CodeNomad uses server routes)
- `client.global.*` — Global config/health (CodeNomad uses server meta endpoint)
- `client.app.*` — App logging/agents
- `client.worktree.*` — Git worktree management (CodeNomad uses server routes)
