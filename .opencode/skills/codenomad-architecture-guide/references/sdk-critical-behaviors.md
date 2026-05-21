# SDK Critical Behaviors

## Critical Behaviors Table

| Behavior | Detail | Impact | Code Location |
|----------|--------|--------|---------------|
| `ignored: true` on assistant parts | Backend only checks for user parts | Assistant parts still sent to AI model | `packages/opencode/src/session/message-v2.ts` |
| Part delete | Message must retain ≥1 part | Delete entire message if last part | `packages/ui/src/stores/session-actions.ts` |
| Metadata on assistant parts | Passed as `providerMetadata` to ai SDK | Flat objects cause fatal schema violations | `packages/opencode/src/session/message-v2.ts` |
| Session revert | Only restores files to Git snapshot | Not an undo mechanism for messages | `packages/opencode/src/session/revert.ts` |
| Empty messages | Backend rejects `parts: []` | Check part count before delete | `packages/ui/src/stores/session-actions.ts` |

## Schema Violation Details

### Assistant Part Metadata (Fatal)

**Root Cause:** `packages/opencode/src/session/message-v2.ts:704-710`

```typescript
if (part.type === "text")
  assistantMessage.parts.push({
    type: "text",
    text: part.text,
    ...(differentModel ? {} : { providerMetadata: part.metadata }),
  })
```

**ai SDK expects:**
```typescript
providerMetadata?: Record<string, Record<string, JsonValue>>
```

**Violation:**
```typescript
// ❌ WRONG: Flat object
metadata: { compacted: true }

// ❌ WRONG: Missing provider name wrapper
metadata: { key: "value" }

// ✅ CORRECT: Nested by provider
metadata: { openai: { key: "value" } }
```

**Fix:** Do not store metadata on assistant text parts. Use client-side registry instead:
```typescript
// ✅ Use client-side registry
// packages/ui/src/stores/session-compaction.ts
const compactedParts = new Set<string>() // part IDs
```

### Empty Messages After Part Deletion

**Root Cause:** Backend validates messages have ≥1 part

**Fix:** Check remaining part count before deleting last part
```typescript
// packages/ui/src/stores/session-actions.ts
if (record.partIds.length <= 1) {
  // Delete entire message instead
  await deleteMessage(sessionID, messageID)
} else {
  await deleteMessagePart(sessionID, messageID, partID)
}
```

## `ignored` Flag Asymmetry

| Part Type | `ignored: true` Effect | Backend Code |
|-----------|------------------------|--------------|
| User text | ✅ Excluded from AI model context | `message-v2.ts:649` |
| Assistant text | ❌ No effect — still sent to model | `message-v2.ts:704-710` |
| Tool | ❌ No `ignored` field exists | N/A |
| Reasoning | ❌ No `ignored` field exists | N/A |

**Implication:** Cannot "soft delete" assistant parts. Must delete or use client-side registry.

## Decision Matrix: Context Modification

| Goal | Strategy | SDK Support | Backend Support | Safe? |
|------|----------|-------------|-----------------|-------|
| Update assistant text | `Part.update()` | ✅ | ✅ | ✅ Yes (no metadata) |
| Update user text | `Part.update()` | ✅ | ✅ | ✅ Yes |
| Hide user part from AI | `ignored: true` | ✅ | ✅ | ✅ Yes |
| Hide assistant part from AI | `ignored: true` | ✅ | ❌ | ❌ No effect |
| Delete part | `Part.delete()` | ✅ | ✅ | ✅ Yes (check message parts) |
| Delete message | `Session.deleteMessage()` | ✅ | ✅ | ✅ Yes (irreversible) |
| Undo message deletion | Client-side restore | ⚠️ Manual | ⚠️ Manual | ⚠️ Must recreate |
| Revert code changes | `Session.revert()` | ✅ | ✅ | ✅ Only affects files |
| Store UI state | Client-side registry | N/A | N/A | ✅ localStorage/Set |

## Race Conditions

### Optimistic Updates

**Symptom:** UI state desync after rapid operations

**Cause:** `removeMessagePartV2()` and `removeMessageV2()` called optimistically before server confirmation

**Mitigation:** SSE events eventually converge state. Do not rely on optimistic state for subsequent operations.

### SSE Disconnection

**Symptom:** Missed events during reconnection

**Mitigation:** `serverEvents` reconnection triggers sync handlers (e.g., `syncPendingPermissions()`) to reconcile state.

## Recommendations

1. **Never store flat metadata on assistant text parts.** Always use client-side registries for UI state.
2. **Prefer user messages for metadata-heavy operations.** User text parts don't pass metadata to ai SDK.
3. **Implement client-side undo for destructive operations.** The SDK has no native message-level undo.
4. **Validate part payloads before sending.** Always spread existing part and override only specific fields.
5. **Handle `ignored` carefully.** It only works for user text parts. Don't rely on it for assistant parts.
