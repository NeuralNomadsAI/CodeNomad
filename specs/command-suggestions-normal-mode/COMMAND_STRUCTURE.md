# Command Structure Analysis

## SDKCommand Interface

```typescript
export type Command = {
  name: string;              // Command name (e.g., "analyze", "refactor")
  description?: string;      // Human-readable description
  agent?: string;            // Associated agent name
  model?: string;            // Model to use for this command
  template: string;          // Command template/implementation
  subtask?: boolean;         // Whether this is a subtask command
}
```

## API: getCommands()

```typescript
export function getCommands(instanceId: string): SDKCommand[]
```

**Returns**: Array of `SDKCommand` objects for the given instance
**Behavior**: 
- Fetches from internal store (not async)
- Returns empty array if instance has no commands
- Commands cached per instance

**Fetch Flow**:
```typescript
// Commands are fetched via:
export async function fetchCommands(instanceId: string, client: OpencodeClient): Promise<void>
// Which calls: client.command.list()
// Then stores via: setCommandMap(...)
```

## Example Command Data

Based on OpenCode CLI patterns, typical commands would be:

```json
{
  "name": "analyze",
  "description": "Analyze code structure and suggest improvements",
  "agent": "code-reviewer",
  "model": "gpt-4",
  "template": "/analyze --file {file} --depth {depth}",
  "subtask": false
}
```

```json
{
  "name": "refactor",
  "description": "Refactor code for better maintainability",
  "agent": "refactor-bot",
  "model": "gpt-4-turbo",
  "template": "/refactor --target {target} --pattern {pattern}",
  "subtask": false
}
```

```json
{
  "name": "test-generate",
  "description": "Generate unit tests for selected code",
  "agent": "test-generator",
  "model": "gpt-4",
  "template": "/test-generate --file {file}",
  "subtask": true
}
```

## Search Fields

For command filtering/search, match against:
1. **name** (primary) - e.g., "analyze" matches "analyze", "analy"
2. **description** (secondary) - e.g., "code structure" in description
3. **agent** (tertiary) - e.g., command's agent name

## Integration Points

### In prompt-input.tsx
- Call `getCommands(instanceId)` when `!/` is typed
- Filter via `filterCommands(query, commands)`
- Display in `CommandSuggestions` component

### In command-filter.ts
- Input: `commands: SDKCommand[]` array
- Query: user-typed partial command name
- Output: filtered and sorted array

## Notes

- Commands are fetched during instance setup (not in real-time)
- Instance ID is passed through component props
- No async needed for display (commands already in store)
- Filter should be case-insensitive
- Search should support partial matches (fuzzy)
