# Tool Call Rendering Implementation

This document describes how tool calls are rendered in Era Code, following the patterns established in the TUI.

## Overview

Each tool type has specialized rendering logic that displays the most relevant information for that tool. This matches the TUI's approach of providing context-specific displays rather than generic input/output dumps.

## Tool-Specific Rendering

### 1. **read** - File Reading

- **Title**: `Read {filename}`
- **Body**: Preview of file content (first 6 lines) from `metadata.preview`
- **Use case**: Shows what file content the assistant is reading

### 2. **edit** - File Editing

- **Title**: `Edit {filename}`
- **Body**: Diff/patch showing changes from `metadata.diff`
- **Special**: Shows diagnostics if available in metadata
- **Use case**: Shows what changes are being made to files

### 3. **write** - File Writing

- **Title**: `Write {filename}`
- **Body**: File content being written (first 10 lines)
- **Special**: Shows diagnostics if available in metadata
- **Use case**: Shows new file content being created

### 4. **bash** - Shell Commands

- **Title**: `Shell {description}` (or command if no description)
- **Body**: Console-style display with `$ command` and output

```
$ npm install vitest
added 50 packages...
```

- **Output from**: `metadata.output`
- **Use case**: Shows command execution and results

### 5. **webfetch** - Web Fetching

- **Title**: `Fetch {url}`
- **Body**: Fetched content (first 10 lines)
- **Use case**: Shows web content being retrieved

### 6. **todowrite** - Task Planning

- **Title**: Dynamic based on todo phase:
  - All pending: "Creating plan"
  - All completed: "Completing plan"
  - Mixed: "Updating plan"
- **Body**: Formatted todo list:
  - `- [x] Completed task`
  - `- [ ] Pending task`
  - `- [ ] ~~Cancelled task~~`
  - `- [ ] In progress task` (highlighted)
- **Use case**: Shows the AI's task planning

### 7. **task** - Delegated Tasks

- **Title**: `Task[subagent_type] {description}`
- **Body**: List of delegated tool calls with icons:

```
⚡ bash: npm install
📖 read package.json
✏️ edit src/app.ts
```

- **Special**: In TUI, includes navigation hints for session tree
- **Use case**: Shows what the delegated agent is doing

### 8. **todoread** - Plan Reading

- **Special**: Hidden in TUI, returns empty string
- **Use case**: Internal tool, not displayed to user

### 9. **glob** - File Pattern Matching

- **Title**: `Glob {pattern}`
- **Use case**: Shows file search patterns

### 10. **grep** - Content Search

- **Title**: `Grep "{pattern}"`
- **Use case**: Shows what content is being searched

### 11. **list** - Directory Listing

- **Title**: `List`
- **Use case**: Shows directory operations

### 12. **patch** - Patching Files

- **Title**: `Patch`
- **Use case**: Shows patch operations

### 13. **invalid** - Invalid Tool Calls

- **Title**: Name of the actual tool attempted
- **Use case**: Shows validation errors

### 14. **Default** - Unknown Tools

- **Title**: Capitalized tool name
- **Body**: Output truncated to 10 lines
- **Use case**: Fallback for any new or custom tools

## Status States

### Pending

- **Icon**: ⏸ (pause symbol)
- **Title**: Action text (e.g., "Writing command...", "Preparing edit...")
- **Border**: Accent color
- **Animation**: Shimmer effect on title
- **Expandable**: Shows "Waiting for permission..." message

### Running

- **Icon**: ⏳ (hourglass)
- **Title**: Same as completed state
- **Border**: Warning color (yellow/orange)
- **Animation**: Pulse on status icon

### Completed

- **Icon**: ✓ (checkmark)
- **Title**: Tool-specific title with arguments
- **Border**: Success color (green)
- **Body**: Tool-specific rendered content

### Error

- **Icon**: ✗ (X mark)
- **Title**: Same format but in error color
- **Border**: Error color (red)
- **Body**: Error message in highlighted box

## Title Rendering Logic

The title follows this pattern:

1. **Pending state**: Show action text

   ```
   "Writing command..."
   "Preparing edit..."
   "Delegating..."
   ```

2. **Completed/Running/Error**: Show specific info

   ```
   "Shell npm install"
   "Edit src/app.ts"
   "Read package.json"
   "Task[general] Search for files"
   ```

3. **Special cases**:
   - `todowrite`: Shows plan phase
   - `todoread`: Just "Plan"
   - `bash`: Uses description if available, otherwise shows command

## Metadata Usage

Tool calls use `metadata` for rich content:

- **read**: `metadata.preview` - file preview content
- **edit**: `metadata.diff` - patch/diff text
- **bash**: `metadata.output` - command output
- **todowrite**: `metadata.todos[]` - todo items with status
- **task**: `metadata.summary[]` - delegated tool calls
- **edit/write**: `metadata.diagnostics` - LSP diagnostics

## Design Principles

1. **Context-specific**: Each tool shows the most relevant information
2. **Progressive disclosure**: Collapsed by default, expand for details
3. **Visual hierarchy**: Icons, colors, and borders indicate status
4. **Truncation**: Long content is truncated (6-10 lines) to prevent overwhelming
5. **Consistency**: All tools follow same header/body/error structure

## Component Structure

```tsx
<div class="tool-call tool-call-status-{status}">
  <button class="tool-call-header" onClick={toggle}>
    <span class="tool-call-icon">▶/▼</span>
    <span class="tool-call-emoji">{icon}</span>
    <span class="tool-call-summary">{title}</span>
    <span class="tool-call-status">{statusIcon}</span>
  </button>

  {expanded && (
    <div class="tool-call-details">
      {/* Tool-specific body content */}
      {error && <div class="tool-call-error-content">{error}</div>}
    </div>
  )}
</div>
```

## CSS Classes

- `.tool-call` - Base container
- `.tool-call-status-{pending|running|completed|error}` - Status-specific styling
- `.tool-call-header` - Clickable header with expand/collapse
- `.tool-call-emoji` - Tool type icon
- `.tool-call-summary` - Tool title/description
- `.tool-call-details` - Expanded content area
- `.tool-call-content` - Code/output content (monospace)
- `.tool-call-todos` - Todo list container
- `.tool-call-task-summary` - Delegated task list
- `.tool-call-error-content` - Error message display

## Future Enhancements

1. **Syntax highlighting**: Use Shiki for code blocks in bash, read, write
2. **Diff rendering**: Better diff visualization for edit tool
3. **Copy buttons**: Quick copy for code/output
4. **File links**: Click filename to open in editor
5. **Diagnostics display**: Show LSP errors/warnings inline
