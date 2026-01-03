# Phase 2 Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire CommandSuggestions and MarkdownPreviewIcon components into the UI, enabling `!/` command suggestions in prompt input and markdown file previews on messages.

**Architecture:** 
- **Feature 1 (CommandSuggestions)**: Add `!/` mode detection in `prompt-input.tsx` handleInput(), manage command filtering with signals, render floating card above input with keyboard navigation
- **Feature 2 (MarkdownPreviewIcon)**: Detect markdown files in message text parts using `detectMarkdownFiles()`, render preview icons in message headers, wire modal state to App.tsx container level

**Tech Stack:** SolidJS (signals, createEffect, For), TypeScript strict mode, command SDK API, markdown file detection utilities

---

## Task 1: Add Command Suggestions Signals to prompt-input.tsx

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:32-50` (signals section)

**Step 1: Add new signals for command mode**

After line 45 (`const [mode, setMode] = createSignal<"normal" | "shell">("normal")`), add these signals:

```typescript
const [commandMode, setCommandMode] = createSignal(false)
const [commandQuery, setCommandQuery] = createSignal("")
const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0)
```

**Step 2: Verify imports include CommandSuggestions**

Check line 1-15 of prompt-input.tsx. Add these imports if missing:

```typescript
import CommandSuggestions from "./command-suggestions"
import { getCommands } from "../stores/commands"
import { filterCommands } from "../lib/command-filter"
```

**Step 3: Verify stores/commands.ts exports exist**

Run: `grep -n "export.*getCommands" packages/ui/src/stores/commands.ts`
Expected: Line shows `export function getCommands(...)`

**Step 4: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: add command mode signals to prompt-input"
```

---

## Task 2: Implement `!/` Detection in handleInput()

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:665-711` (handleInput function)

**Step 1: Add `!/` detection logic after `@` detection**

In the `handleInput()` function, after the `@` detection block (around line 710 after `setShowPicker(false)`), add:

```typescript
    // Command suggestions mode: !/
    const lastExclamationIndex = value.lastIndexOf("!")
    let commandModeActive = false
    let commandText = ""

    if (lastExclamationIndex !== -1) {
      const afterExclamation = value.substring(lastExclamationIndex + 1, cursorPos)
      const hasSpace = afterExclamation.includes(" ") || afterExclamation.includes("\n")

      if (
        !hasSpace &&
        cursorPos === lastExclamationIndex + afterExclamation.length + 1 &&
        lastExclamationIndex + 1 < cursorPos &&
        value[lastExclamationIndex + 1] === "/" // Check for !/
      ) {
        commandModeActive = true
        commandText = afterExclamation.substring(1) // Strip the / from !/query
      }
    }

    setCommandMode(commandModeActive)
    if (commandModeActive) {
      setCommandQuery(commandText)
      setSelectedCommandIndex(0)
    } else {
      setCommandQuery("")
      setSelectedCommandIndex(0)
    }
```

**Step 2: Run typecheck to verify syntax**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors in prompt-input.tsx

**Step 3: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: add !/ command mode detection in prompt-input"
```

---

## Task 3: Add Command Selection Handler in prompt-input.tsx

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:820-835` (after handlePickerClose)

**Step 1: Add insertCommand handler**

After the `handlePickerClose()` function (around line 832), add:

```typescript
  function handleCommandSelect(command: SDKCommand) {
    const currentPrompt = prompt()
    const exclamationIndex = currentPrompt.lastIndexOf("!")
    const cursorPos = textareaRef?.selectionStart || 0

    if (exclamationIndex !== -1 && exclamationIndex < cursorPos) {
      const before = currentPrompt.substring(0, exclamationIndex)
      const after = currentPrompt.substring(cursorPos)
      
      // Insert command template (e.g., "/analyze")
      const commandText = command.template || `/${command.name}`
      const newPrompt = before + commandText + " " + after
      
      setPrompt(newPrompt)
      setCommandMode(false)
      setCommandQuery("")
      setSelectedCommandIndex(0)

      setTimeout(() => {
        if (textareaRef) {
          const newCursorPos = exclamationIndex + commandText.length + 1
          textareaRef.setSelectionRange(newCursorPos, newCursorPos)
          textareaRef.focus()
        }
      }, 0)
    }
  }

  function handleCommandClose() {
    setCommandMode(false)
    setCommandQuery("")
    setSelectedCommandIndex(0)
    setTimeout(() => textareaRef?.focus(), 0)
  }
```

**Step 2: Import SDKCommand type**

Add to imports (line 1-15):

```typescript
import type { Command as SDKCommand } from "@opencode-ai/sdk"
```

**Step 3: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: add command selection handler to prompt-input"
```

---

## Task 4: Add Keyboard Navigation for Command Mode

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:595-650` (handleKeyDown function)

**Step 1: Extend handleKeyDown for command mode navigation**

In the existing `handleKeyDown()` function, add this block BEFORE the existing `@` mode checks (around line 595):

```typescript
    // Command mode navigation (!/mode)
    if (commandMode()) {
      const commands = filterCommands(commandQuery(), getCommands(props.instanceId))
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault()
          setSelectedCommandIndex(Math.max(0, selectedCommandIndex() - 1))
          return
        case "ArrowDown":
          e.preventDefault()
          setSelectedCommandIndex(Math.min(commands.length - 1, selectedCommandIndex() + 1))
          return
        case "Enter":
          e.preventDefault()
          if (commands.length > 0) {
            handleCommandSelect(commands[selectedCommandIndex()])
          }
          return
        case "Escape":
          e.preventDefault()
          handleCommandClose()
          return
      }
    }
```

**Step 2: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: add keyboard navigation for command mode"
```

---

## Task 5: Render CommandSuggestions Component in prompt-input.tsx

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:900-1100` (JSX render section)

**Step 1: Find the UnifiedPicker render location**

Run: `grep -n "<UnifiedPicker" packages/ui/src/components/prompt-input.tsx`
Expected: Line number showing UnifiedPicker in JSX

**Step 2: Add CommandSuggestions JSX after UnifiedPicker**

After the closing `</UnifiedPicker>` tag, add:

```jsx
      <CommandSuggestions
        commands={() => getCommands(props.instanceId)}
        isOpen={() => commandMode()}
        searchQuery={() => commandQuery()}
        selectedIndex={() => selectedCommandIndex()}
        onSelect={handleCommandSelect}
        onClose={handleCommandClose}
        onQueryChange={setCommandQuery}
        onSelectedIndexChange={setSelectedCommandIndex}
      />
```

**Step 3: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: render CommandSuggestions in prompt-input"
```

---

## Task 6: Add Markdown Preview Icon to message-block.tsx

**Files:**
- Modify: `packages/ui/src/components/message-block.tsx:1-50` (imports)
- Modify: `packages/ui/src/components/message-block.tsx:150-250` (component definition and props)

**Step 1: Add imports**

At the top of message-block.tsx (after existing imports), add:

```typescript
import MarkdownPreviewIcon from "./markdown-preview-icon"
import { detectMarkdownFiles } from "../lib/markdown-file-detector"
```

**Step 2: Add onOpenPreview prop to MessageBlockProps**

Find the interface `MessageBlockProps` in message-block.tsx. Add:

```typescript
  // Callback when user clicks markdown preview icon
  onOpenPreview?: (filePath: string) => void
```

**Step 3: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/ui/src/components/message-block.tsx
git commit -m "feat: add markdown preview icon imports and prop"
```

---

## Task 7: Detect and Render Markdown Files in message-block.tsx

**Files:**
- Modify: `packages/ui/src/components/message-block.tsx:250-350` (message part rendering)

**Step 1: Find the message parts rendering loop**

Run: `grep -n "For<" packages/ui/src/components/message-block.tsx | grep -i "parts\|message"`
Expected: Line number showing the For loop that renders message parts

**Step 2: Add markdown detection in text part rendering**

In the render JSX where text parts are rendered, add this logic:

```typescript
// Inside the loop rendering message parts, for text parts:
{/* Detect and render markdown file preview icons */}
{part.type === "text" && part.text && (() => {
  const markdownFiles = detectMarkdownFiles(part.text)
  return (
    <Show when={markdownFiles.length > 0}>
      <div class="message-markdown-icons">
        <For each={markdownFiles}>
          {(filePath) => (
            <MarkdownPreviewIcon
              filePath={filePath}
              onOpenPreview={(path) => props.onOpenPreview?.(path)}
            />
          )}
        </For>
      </div>
    </Show>
  )
})()}
```

**Step 2: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/ui/src/components/message-block.tsx
git commit -m "feat: detect and render markdown preview icons in messages"
```

---

## Task 8: Add Modal State to App.tsx

**Files:**
- Modify: `packages/ui/src/App.tsx:65-80` (signals section)
- Modify: `packages/ui/src/App.tsx:1-20` (imports)

**Step 1: Add imports**

At the top of App.tsx, add:

```typescript
import MarkdownPreviewModal from "./components/markdown-preview-modal"
import { useMarkdownPreview } from "./lib/hooks/use-markdown-preview"
```

**Step 2: Add modal state signals**

After the existing signals (around line 75), add:

```typescript
  const [previewFileOpen, setPreviewFileOpen] = createSignal(false)
  const [previewFilePath, setPreviewFilePath] = createSignal<string | null>(null)
  const markdownPreview = useMarkdownPreview()
```

**Step 3: Add handler for opening preview**

Add this function in the App component body:

```typescript
  const handleOpenMarkdownPreview = async (filePath: string) => {
    setPreviewFilePath(filePath)
    setPreviewFileOpen(true)
    await markdownPreview.fetch(filePath)
  }

  const handleCloseMarkdownPreview = () => {
    setPreviewFileOpen(false)
    setPreviewFilePath(null)
    markdownPreview.clearCurrent()
  }
```

**Step 4: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/ui/src/App.tsx
git commit -m "feat: add markdown preview modal state to App.tsx"
```

---

## Task 9: Render MarkdownPreviewModal in App.tsx

**Files:**
- Modify: `packages/ui/src/App.tsx:200-300` (JSX render section)

**Step 1: Find the Dialog root in App JSX**

Run: `grep -n "<Dialog" packages/ui/src/App.tsx`
Expected: Line number showing Dialog component

**Step 2: Add MarkdownPreviewModal after other modals**

After the closing tag of another modal (like AlertDialog or similar), add:

```jsx
      <MarkdownPreviewModal
        isOpen={() => previewFileOpen()}
        filePath={() => previewFilePath() || ""}
        content={() => markdownPreview.content()}
        isLoading={() => markdownPreview.isLoading()}
        error={() => markdownPreview.error()}
        onClose={handleCloseMarkdownPreview}
      />
```

**Step 2: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/ui/src/App.tsx
git commit -m "feat: render MarkdownPreviewModal in App.tsx"
```

---

## Task 10: Wire onOpenPreview Prop Through Instance Shell

**Files:**
- Modify: `packages/ui/src/components/instance/instance-shell2.tsx:200-300` (instance shell JSX)

**Step 1: Find where MessageBlock is rendered**

Run: `grep -n "<MessageBlock" packages/ui/src/components/instance/instance-shell2.tsx`
Expected: Line number showing MessageBlock component

**Step 2: Add onOpenPreview prop**

Update the `<MessageBlock>` tag to include:

```jsx
        <MessageBlock
          // ... existing props ...
          onOpenPreview={props.onOpenMarkdownPreview}
        />
```

**Step 3: Verify InstanceShell props**

Check the `InstanceShellProps` interface. Add:

```typescript
  onOpenMarkdownPreview?: (filePath: string) => void
```

**Step 4: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/ui/src/components/instance/instance-shell2.tsx
git commit -m "feat: wire onOpenPreview prop through instance shell"
```

---

## Task 11: Pass Handler from App to InstanceShell

**Files:**
- Modify: `packages/ui/src/App.tsx` (InstanceShell JSX)

**Step 1: Find where InstanceShell is rendered**

Run: `grep -n "<InstanceShell" packages/ui/src/App.tsx`
Expected: Line number showing InstanceShell component

**Step 2: Add onOpenMarkdownPreview prop**

Update the `<InstanceShell>` tag to include:

```jsx
        <InstanceShell
          // ... existing props ...
          onOpenMarkdownPreview={handleOpenMarkdownPreview}
        />
```

**Step 3: Run typecheck**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/ui/src/App.tsx
git commit -m "feat: pass markdown preview handler to InstanceShell"
```

---

## Task 12: Verify Feature 1 Works in Browser

**Files:**
- Test: `packages/ui/src/components/prompt-input.tsx`

**Step 1: Start dev server**

Run: `npm run dev`
Expected: App loads without errors, hot reload working

**Step 2: Test command suggestions trigger**

1. Type `!/test` in prompt input
2. Watch for CommandSuggestions floating card above input
3. Type `!/ana` to filter for "analyze" command
4. Verify commands match the search query

**Step 3: Test keyboard navigation**

1. With command suggestions open, press ↑ and ↓
2. Verify selected item highlights change
3. Press Enter to select a command
4. Verify command template is inserted into prompt

**Step 4: Test escape closes suggestions**

1. Open command suggestions with `!/`
2. Press Escape
3. Verify card closes and focus returns to input

**Step 5: Manual commit if tests pass**

```bash
git add -A && git commit -m "test: verify command suggestions feature works"
```

---

## Task 13: Verify Feature 2 Works in Browser

**Files:**
- Test: `packages/ui/src/components/message-block.tsx`, `App.tsx`

**Step 1: Ensure dev server still running**

Expected: App loads, previous tests still work

**Step 2: Create a message with markdown reference**

1. Send a message like: "Check the docs/guide.md file for details"
2. Wait for message to render
3. Verify book icon appears next to the message

**Step 3: Test markdown preview opens**

1. Click the book icon next to markdown filename
2. Verify MarkdownPreviewModal opens
3. Check that content loads (mock data in MVP)
4. Verify file path displays correctly

**Step 4: Test modal close button**

1. Click the close button in modal
2. Verify modal closes
3. Verify focus returns to message input

**Step 5: Test multiple markdown files**

1. Send message with multiple markdown references
2. Verify multiple icons render
3. Click each icon and verify correct file previews

**Step 6: Manual commit if tests pass**

```bash
git add -A && git commit -m "test: verify markdown preview feature works"
```

---

## Task 14: Run Full Typecheck and Build

**Files:**
- Test: All modified TypeScript files

**Step 1: Run typecheck on UI package**

Run: `npm run typecheck --workspace @codenomad/ui`
Expected: `✓ type checking passed` or similar success message

**Step 2: Run full typecheck**

Run: `npm run typecheck`
Expected: All packages pass typecheck

**Step 3: Build UI**

Run: `npm run build:ui`
Expected: Build completes without errors

**Step 4: Verify no console errors**

Open browser dev console (F12), reload app
Expected: No TypeScript or runtime errors in console

**Step 5: Final commit**

```bash
git add -A && git commit -m "feat: phase 2 integration complete - command suggestions & markdown preview"
```

---

## Summary

**Total tasks:** 14 (7 feature + 4 wiring + 2 verification + 1 final)
**Estimated time:** 2-3 hours
**Key files modified:** 4 (prompt-input.tsx, message-block.tsx, App.tsx, instance-shell2.tsx)
**Dependencies:** CommandSuggestions, MarkdownPreviewIcon components (Phase 1 - completed)

---

## Execution Checklist

- [ ] Task 1: Add signals
- [ ] Task 2: Implement `!/` detection
- [ ] Task 3: Add command selection handler
- [ ] Task 4: Add keyboard navigation
- [ ] Task 5: Render CommandSuggestions
- [ ] Task 6: Add preview icon imports
- [ ] Task 7: Detect and render markdown files
- [ ] Task 8: Add modal state to App.tsx
- [ ] Task 9: Render modal component
- [ ] Task 10: Wire prop through instance shell
- [ ] Task 11: Pass handler from App
- [ ] Task 12: Verify Feature 1 in browser
- [ ] Task 13: Verify Feature 2 in browser
- [ ] Task 14: Run typecheck and build
