# Command Suggestions for Normal Mode (/) - Implementation Plan

## Feature Overview
Enable users to access command suggestions in normal chat mode by pressing `!/` sequence, mirroring OpenCode CLI behavior. Commands display in a floating card at the top of the chat box with search filtering, scrolling, and proper z-axis layering.

## Success Criteria
- ✅ Users can trigger command suggestions by typing `!/` in prompt
- ✅ Filtered command list displays above prompt input in floating card
- ✅ Card is draggable and scrollable, doesn't obscure chat
- ✅ Selection via arrow keys + Enter or click adds command to prompt
- ✅ ESC or backspace exits command mode
- ✅ Works in Electron and web browser
- ✅ Follows existing CodeNomad design patterns (z-axis, colors, spacing)

## Technical Approach

### Data Flow
```
User types "/" in normal mode → 
Detect "!/" sequence → 
Fetch commands from server → 
Filter by search → 
Display CommandSuggestions floating component → 
User selects → 
Insert into prompt → 
Clear suggestions
```

### Reusable Patterns
- **UnifiedPicker component** (for mention/agent suggestions) - REFERENCE
- **Shell mode detection** (prompt-input.tsx line 45) - TEMPLATE
- **Floating card positioning** (modal.css z-axis, fixed positioning) - REFERENCE
- **Keyboard handling** (prompt-input.tsx handleKeyDown) - EXTEND

### New Components
- `CommandSuggestions.tsx` - Floating card with command list
- `CommandSuggestionsItem.tsx` - Individual command entry
- Styling: `command-suggestions.css`

### File Detection Strategy
- In `prompt-input.tsx`: Add state for `!/` sequence detection
- Trigger on: User types `/` while `mode === "shell"` is being entered
- Clear on: ESC, Backspace to `!`, Click outside, Selection

### Key Files to Modify
1. `packages/ui/src/components/prompt-input.tsx` - Add `!/` detection, suggestions state
2. `packages/ui/src/stores/commands.ts` - Verify command structure
3. Create `packages/ui/src/components/command-suggestions.tsx` - New component
4. Create `packages/ui/src/styles/messaging/command-suggestions.css` - Styling

## Task Breakdown

### Phase 1: Data & State Management (Tasks 1-3)
**Parallel tasks** ⚡

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 1.1 | Analyze command structure in `stores/commands.ts` | 30m | Document command interface and getCommands() signature |
| 1.2 | Create command filtering/search utility | 45m | `lib/command-filter.ts` - export filterCommands(query, commands) |
| 1.3 | Extend prompt-input state for command mode | 45m | Add `commandMode` signal and `!/` detection logic |

### Phase 2: UI Components (Tasks 2-1 to 2-3)
**Sequential**: 2.1 → 2.2 → 2.3

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 2.1 | Create CommandSuggestions floating card component | 1.5h | `components/command-suggestions.tsx` with keyboard nav |
| 2.2 | Create CommandSuggestionItem subcomponent | 45m | `components/command-suggestion-item.tsx` with hover/select states |
| 2.3 | Create component styling with z-axis, positioning | 1h | `styles/messaging/command-suggestions.css` |

### Phase 3: Integration (Tasks 3-1 to 3-3)
**Sequential**: 3.1 → 3.2 → 3.3

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 3.1 | Integrate CommandSuggestions into PromptInput | 1h | Wire state + handlers in prompt-input.tsx |
| 3.2 | Implement keyboard navigation (arrow keys, Enter, ESC) | 1h | Complete keyboard flow in CommandSuggestions + PromptInput |
| 3.3 | Implement command insertion into prompt on selection | 45m | Selection handler inserts command text, clears suggestions |

### Phase 4: Polish & Testing (Tasks 4-1 to 4-3)
**Parallel** ⚡

| Task ID | Description | Estimate | Deliverable |
|---------|-------------|----------|-------------|
| 4.1 | Handle edge cases (empty results, overflow, click outside) | 45m | Defensive code + modal closure |
| 4.2 | Test in Electron and browser | 1h | Verify z-axis, positioning, keyboard on both platforms |
| 4.3 | Style refinement (colors, spacing, animations) | 45m | Polish UI to match CodeNomad design tokens |

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Command list too long | Implement scrolling in card, default show 8-10 items, rest via scroll |
| Z-axis conflicts with chat | Use fixed positioning with z-index value consistent with `.prompt-input-overlay` |
| Keyboard navigation complexity | Map: ↓↑ for navigation, Enter for selection, ESC for exit (standard pattern) |
| Mode transition confusion | Clear visual indicator when entering command mode (e.g., "Command mode: /" text) |
| Server doesn't have command list | Use mock command array as fallback, fetch from `getCommands(instanceId)` |

## Component Props & Interfaces

### CommandSuggestions Props
```typescript
interface CommandSuggestionsProps {
  commands: SDKCommand[]
  isOpen: boolean
  searchQuery: string
  onSelect: (command: SDKCommand) => void
  onClose: () => void
  position: { top: number; left: number }
}
```

### CommandSuggestionItem Props
```typescript
interface CommandSuggestionItemProps {
  command: SDKCommand
  isSelected: boolean
  onSelect: (command: SDKCommand) => void
}
```

## Files to Create

```
specs/command-suggestions-normal-mode/
├── IMPLEMENTATION_PLAN.md (this file)
├── COMPONENT_SPEC.md
├── TESTING_STRATEGY.md
├── command-filter.ts (utility)
└── command-suggestions.tsx (example component)
```

## Integration Points

1. **Prompt Input** (`prompt-input.tsx`):
   - Add `commandMode` signal
   - Add `!/` detection in `handleKeyDown()`
   - Render `<Show when={commandMode()}>` with CommandSuggestions
   - Pass handlers: `onSelect`, `onClose`

2. **Commands Store** (`stores/commands.ts`):
   - Verify `getCommands()` API signature
   - Ensure command structure has `name`, `description`, `usage`

3. **Styling** (aggregate file):
   - Import new `command-suggestions.css` into `styles/messaging.css`
   - Ensure z-axis consistent with modal.css patterns

## Success Verification Checklist

- [ ] User can type `!/` in prompt input
- [ ] Command suggestions appear above prompt in floating card
- [ ] Card displays 8-10 items with scroll for additional
- [ ] Arrow keys navigate up/down
- [ ] Enter key selects highlighted command
- [ ] Selected command text inserted into prompt
- [ ] Command mode exits on ESC or backspace
- [ ] Card doesn't block chat history
- [ ] Z-axis follows chat window (not hidden behind)
- [ ] Works in Electron app
- [ ] Works in web browser
- [ ] Handles empty command list gracefully
- [ ] Filtering works with partial command names

## Estimated Total Time
- **Planning**: 2h (research + design)
- **Implementation**: 8-10h (components + integration + testing)
- **Iteration/Polish**: 2-3h
- **Total: 12-15 hours**

## Notes
- No new dependencies required (all tools present)
- Leverage existing UnifiedPicker pattern for consistency
- Follow shell mode implementation as template for mode detection
- Prioritize keyboard accessibility over mouse interactions
