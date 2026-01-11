# Expand Chat Input Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an expand/minimize button to the chat input section that allows users to expand the textarea to 50% or 80% of the chat window height with single/double-click, maintaining Gemini-like UX.

**Architecture:** Add a new state signal `expandState` to track 3 states (normal/50%/80%), create an `ExpandButton` component positioned alongside history buttons, calculate dynamic heights based on parent container, apply smooth CSS transitions, and add comprehensive hover tooltips explaining both click behaviors.

**Tech Stack:** SolidJS (signals/effects), lucide-solid icons (Maximize2/Minimize2), CSS transitions, existing button styling patterns from prompt-input.css

---

## Task 1: Add expand state signal and types

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:33-52`

**Step 1: Understand current state structure**

Read lines 33-52 to see how signals like `prompt`, `mode`, `showPicker` are created.

Expected: See `createSignal` patterns for boolean and string states.

**Step 2: Add expand state signal after line 47**

In `packages/ui/src/components/prompt-input.tsx`, after line 47 (`const [mode, setMode] = createSignal<"normal" | "shell">("normal")`), add:

```typescript
const [expandState, setExpandState] = createSignal<"normal" | "fifty" | "eighty">("normal")
```

**Step 3: Add height calculation memos after line 58**

Add these utility functions right after the signal definitions (before the createEffect on line 59):

```typescript
const calculateContainerHeight = () => {
  if (!containerRef) return 0
  const rect = containerRef.getBoundingClientRect()
  const root = containerRef.closest(".session-view")
  if (!root) return 0
  const rootRect = root.getBoundingClientRect()
  return rootRect.height - rect.top
}

const getExpandedHeight = (): string => {
  const state = expandState()
  if (state === "normal") return "auto"
  const containerHeight = calculateContainerHeight()
  if (state === "fifty") return `${containerHeight * 0.5}px`
  return `${containerHeight * 0.8}px`
}
```

**Step 4: Verify no syntax errors**

Run in terminal:
```bash
cd packages/ui && npm run type-check
```

Expected: No TypeScript errors in prompt-input.tsx.

**Step 5: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: add expand state signal and height calculation helpers"
```

---

## Task 2: Create ExpandButton component

**Files:**
- Create: `packages/ui/src/components/expand-button.tsx`

**Step 1: Create the component file**

Create `packages/ui/src/components/expand-button.tsx` with this content:

```typescript
import { createSignal, Show } from "solid-js"
import { Maximize2, Minimize2 } from "lucide-solid"

interface ExpandButtonProps {
  expandState: () => "normal" | "fifty" | "eighty"
  onToggleExpand: (nextState: "normal" | "fifty" | "eighty") => void
}

export default function ExpandButton(props: ExpandButtonProps) {
  const [clickTime, setClickTime] = createSignal<number>(0)
  const DOUBLE_CLICK_THRESHOLD = 300

  function handleClick() {
    const now = Date.now()
    const lastClick = clickTime()
    const isDoubleClick = now - lastClick < DOUBLE_CLICK_THRESHOLD

    setClickTime(now)

    const current = props.expandState()

    if (isDoubleClick) {
      // Double click behavior
      if (current === "normal") {
        props.onToggleExpand("fifty")
      } else if (current === "fifty") {
        props.onToggleExpand("eighty")
      } else {
        props.onToggleExpand("normal")
      }
    } else {
      // Single click behavior
      if (current === "normal") {
        props.onToggleExpand("fifty")
      } else {
        props.onToggleExpand("normal")
      }
    }

    // Reset click timer after threshold
    setTimeout(() => setClickTime(0), DOUBLE_CLICK_THRESHOLD)
  }

  const getTooltip = () => {
    const current = props.expandState()
    if (current === "normal") {
      return "Click to expand (50%) • Double-click to expand further (80%)"
    } else if (current === "fifty") {
      return "Double-click to expand to 80% • Click to minimize"
    } else {
      return "Click to minimize • Double-click to expand to 50%"
    }
  }

  return (
    <button
      type="button"
      class="prompt-expand-button"
      onClick={handleClick}
      disabled={false}
      aria-label="Toggle chat input height"
      title={getTooltip()}
    >
      <Show
        when={props.expandState() === "normal"}
        fallback={<Minimize2 class="h-5 w-5" aria-hidden="true" />}
      >
        <Maximize2 class="h-5 w-5" aria-hidden="true" />
      </Show>
    </button>
  )
}
```

**Step 2: Verify component syntax**

Run in terminal:
```bash
cd packages/ui && npm run type-check
```

Expected: No TypeScript errors in expand-button.tsx.

**Step 3: Commit**

```bash
git add packages/ui/src/components/expand-button.tsx
git commit -m "feat: create ExpandButton component with click/double-click logic"
```

---

## Task 3: Integrate ExpandButton into PromptInput

**Files:**
- Modify: `packages/ui/src/components/prompt-input.tsx:1-3, 1040-1250`

**Step 1: Add import for ExpandButton**

In `packages/ui/src/components/prompt-input.tsx`, at line 1 after the existing imports, add:

```typescript
import ExpandButton from "./expand-button"
```

**Step 2: Add expand handler function**

After the `handleAbort` function (around line 703), add:

```typescript
function handleExpandToggle(nextState: "normal" | "fifty" | "eighty") {
  setExpandState(nextState)
  // Keep focus on textarea
  textareaRef?.focus()
}
```

**Step 3: Render ExpandButton in JSX**

Find the section where history buttons are rendered (around line 1188-1211). Right before the closing `</Show>` tag of the history buttons, add the ExpandButton:

```typescript
<Show when={hasHistory()}>
  <div class="prompt-expand-top">
    <ExpandButton
      expandState={expandState}
      onToggleExpand={handleExpandToggle}
    />
  </div>
</Show>
```

Wait - actually, the expand button should always show (not conditionally with history). Let me correct:

Replace the above with - add this RIGHT AFTER the `</Show>` closing tag for history buttons (after line 1211):

```typescript
<div class="prompt-expand-top">
  <ExpandButton
    expandState={expandState}
    onToggleExpand={handleExpandToggle}
  />
</div>
```

**Step 4: Apply dynamic height to textarea**

Find the textarea element (around line 1166-1187). Modify the style binding on the textarea to include dynamic height:

Change from:
```typescript
style={attachments().length > 0 ? { "padding-top": "8px" } : {}}
```

To:
```typescript
style={{
  "padding-top": attachments().length > 0 ? "8px" : "0",
  "height": getExpandedHeight(),
  "overflow-y": expandState() !== "normal" ? "auto" : "visible",
  "transition": "height 0.25s ease",
}}
```

**Step 5: Verify no errors**

Run in terminal:
```bash
cd packages/ui && npm run type-check
```

Expected: No TypeScript errors.

**Step 6: Commit**

```bash
git add packages/ui/src/components/prompt-input.tsx
git commit -m "feat: integrate ExpandButton and apply dynamic height to textarea"
```

---

## Task 4: Add CSS styles for expand button positioning

**Files:**
- Modify: `packages/ui/src/styles/messaging/prompt-input.css:72-107`

**Step 1: Add prompt-expand-top styles**

After the `.prompt-history-bottom` rule (around line 88), add:

```css
.prompt-expand-top {
  position: absolute;
  top: 0.3rem;
  right: 3.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.prompt-expand-button {
  @apply w-9 h-9 flex items-center justify-center rounded-md;
  color: var(--text-muted);
  background-color: rgba(15, 23, 42, 0.04);
  transition: background-color 0.15s ease, color 0.15s ease;
  padding: 0;
}

.prompt-expand-button:hover:not(:disabled) {
  background-color: var(--surface-secondary);
  color: var(--text-primary);
}

.prompt-expand-button:active:not(:disabled) {
  background-color: var(--accent-primary);
  color: var(--text-inverted);
  transform: scale(0.95);
}

.prompt-expand-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

**Step 2: Adjust prompt-input-field-container for expanded states**

After the `.prompt-input-field` rule (around line 37), add:

```css
.prompt-input-field-container {
  position: relative;
  width: 100%;
  min-height: 56px;
  flex: 1 1 auto;
  height: 100%;
  min-width: 0;
  transition: height 0.25s ease;
}
```

Actually, the min-height should remain. Let me provide the corrected version - modify the existing `.prompt-input-field-container` rule (lines 23-30) to add the transition:

Change line 24 from:
```css
.prompt-input-field-container {
  position: relative;
  width: 100%;
  min-height: 56px;
  flex: 1 1 auto;
  height: 100%;
  min-width: 0;
}
```

To:
```css
.prompt-input-field-container {
  position: relative;
  width: 100%;
  min-height: 56px;
  flex: 1 1 auto;
  height: 100%;
  min-width: 0;
  transition: height 0.25s ease;
}
```

**Step 3: Verify CSS syntax**

Run in terminal:
```bash
npm run build --workspace @neuralnomads/codenomad-ui
```

Expected: Build succeeds with no CSS errors.

**Step 4: Commit**

```bash
git add packages/ui/src/styles/messaging/prompt-input.css
git commit -m "style: add expand button positioning and styles"
```

---

## Task 5: Test expand/minimize functionality in dev

**Files:**
- No new files

**Step 1: Start dev server**

Run in terminal:
```bash
npm run dev --workspace @neuralnomads/codenomad-ui
```

Wait for the server to start and print the local URL.

**Step 2: Test expand button visibility**

- Open the dev app in browser
- Create/open a session
- Verify expand button appears in top-right corner of input area, left of arrow buttons
- Verify button shows Maximize2 icon

**Step 3: Test single-click to 50% expand**

- Click the expand button once
- Verify textarea height increases to ~50% of chat window
- Verify icon changes to Minimize2
- Verify tooltip text updates

**Step 4: Test double-click from normal to 80% expand**

- Click expand button twice rapidly (within 300ms)
- Verify textarea height jumps to ~80% of chat window
- Verify scrollbar appears if content is long
- Type some text to verify scrolling works

**Step 5: Test minimize from 80%**

- Click expand button once
- Verify textarea collapses back to normal height (56px min-height)
- Verify icon changes back to Maximize2

**Step 6: Test expand button with 50% state**

- Single-click expand button → should go to 50%
- Double-click expand button → should go to 80%
- Verify tooltip updates to "Double-click to expand to 80% • Click to minimize"

**Step 7: Verify arrow buttons unchanged**

- Verify up/down arrow buttons still visible and functional
- Verify Stop/Start buttons position unchanged
- Verify all buttons maintain original sizes

**Step 8: Verify smooth transitions**

- Watch height changes - should see smooth 250ms transition
- No jarring jumps or layout shifts

**Expected Results:**
- All expand/minimize transitions work as specified
- No overlapping buttons
- Scrollbar appears correctly when needed
- Tooltips are comprehensive and helpful

If any test fails, return to the task that needs fixing before continuing.

**Step 9: Manual testing complete**

Once all tests pass, stop the dev server:
```bash
Ctrl+C
```

**Step 10: Commit test verification**

```bash
git add -A
git commit -m "test: verify expand button functionality and UX"
```

---

## Task 6: Final cleanup and verification

**Files:**
- Review: `packages/ui/src/components/prompt-input.tsx`
- Review: `packages/ui/src/components/expand-button.tsx`
- Review: `packages/ui/src/styles/messaging/prompt-input.css`

**Step 1: Verify no console errors**

Restart dev server and check browser console:
```bash
npm run dev --workspace @neuralnomads/codenomad-ui
```

Open DevTools console - should show no warnings or errors related to expand button.

**Step 2: Check responsive behavior**

Resize browser window to different sizes - verify button positioning remains correct at all sizes.

**Step 3: Verify with attachments**

- Add an attachment (paste an image or large text)
- Expand the input
- Verify attachment chips display correctly above expanded textarea

**Step 4: Test with history buttons**

- Navigate through prompt history with arrow buttons while expanded
- Verify history navigation still works
- Verify expand button doesn't interfere with history buttons

**Step 5: Build for production**

```bash
npm run build --workspace @neuralnomads/codenomad-ui
```

Expected: Build succeeds with no errors.

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete expand chat input feature with full UX"
```

---

## Summary

This plan implements the expand chat input feature across 6 tasks:

1. ✅ Add expand state signal and height helpers
2. ✅ Create ExpandButton component with click/double-click logic
3. ✅ Integrate ExpandButton and apply dynamic heights
4. ✅ Add CSS styles for button and positioning
5. ✅ Test all functionality in dev
6. ✅ Final verification and build

**Estimated time:** 45-60 minutes total

**Key points:**
- Expand button positioned top-right, left of arrow buttons
- 3 states: normal (56px min) → 50% height → 80% height
- Single-click advances one state, double-click skips to 80%
- Smooth 250ms transitions with scrollbar support
- Comprehensive hover tooltips explain all behaviors
- Maintains all existing button positions and sizes
