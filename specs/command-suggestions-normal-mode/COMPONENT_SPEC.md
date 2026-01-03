# Command Suggestions Component Specification

## Component: CommandSuggestions

Floating card that displays filtered command suggestions above the prompt input.

### Props Interface

```typescript
interface CommandSuggestionsProps {
  // List of available commands to display
  commands: SDKCommand[]

  // Whether suggestions panel is visible
  isOpen: boolean

  // Currently searched command name/keyword
  searchQuery: string

  // Index of currently selected (highlighted) item (keyboard navigation)
  selectedIndex: number

  // Callback when user selects a command
  onSelect: (command: SDKCommand) => void

  // Callback to close suggestions panel
  onClose: () => void

  // Callback when user types in search
  onQueryChange: (query: string) => void

  // Position relative to parent (prompt input container)
  position?: { top: number; left: number }

  // Maximum items to show before scrolling
  maxVisibleItems?: number // default: 8
}
```

### State Management

**Parent (PromptInput) owns:**
- `commandMode` - boolean, true when `!/` is detected
- `commandQuery` - string, what user typed after `/`
- `commands` - SDKCommand[], fetched from store
- `selectedIndex` - number, for keyboard navigation

**Component manages:**
- Filtered results (derived from props)
- Scroll position

### Behavior

#### Display Rules
- Shows when `isOpen === true`
- Displays up to 8 items by default
- Shows "No commands found" when filtered results empty
- Sorted by relevance (fuzzysort)

#### Keyboard Navigation
- **↓** / **↑**: Navigate down/up in list
- **Enter**: Select highlighted command
- **Escape**: Close suggestions
- **Backspace** (when query empty): Exit command mode, close suggestions

#### Mouse Interaction
- Hover: Highlight item
- Click: Select command
- Click outside: Close suggestions

#### Position & Styling
- Fixed positioning above prompt input
- Width: 100% of prompt input container
- Max height: 350px (8 items × ~45px each + padding)
- Scrollbar for overflow
- Z-index: matches `.prompt-input-overlay` (visible above chat)
- Background: matches prompt input styling (slight contrast)

### Example Usage

```tsx
<CommandSuggestions
  commands={filteredCommands()}
  isOpen={commandMode()}
  searchQuery={commandQuery()}
  selectedIndex={selectedCommandIndex()}
  onSelect={(cmd) => insertCommand(cmd)}
  onClose={() => setCommandMode(false)}
  onQueryChange={(q) => setCommandQuery(q)}
  position={{ top: -340, left: 0 }}
/>
```

---

## Component: CommandSuggestionItem

Individual command item within suggestions list.

### Props Interface

```typescript
interface CommandSuggestionItemProps {
  // The command to display
  command: SDKCommand

  // Whether this item is currently highlighted/selected
  isSelected: boolean

  // Callback when item is clicked
  onClick: (command: SDKCommand) => void

  // Callback when item is hovered
  onHover?: (command: SDKCommand) => void

  // Search query for highlighting matches in text
  searchQuery?: string
}
```

### Rendering

Layout:
```
┌─────────────────────────────────────┐
│ [icon] analyze    Analyze code      │
│        /analyze --file {file}       │
└─────────────────────────────────────┘
```

- **Icon**: Command type indicator or generic command icon
- **Name**: Command name (highlighted if matches query)
- **Description**: Short description (gray text, truncated if long)
- **Usage**: Template/usage pattern (smaller font, mono)
- **Selection state**: Background highlight if `isSelected`

### Styling

- **Height**: 45-50px
- **Padding**: 8px 12px
- **Hover state**: Subtle background color change
- **Selected state**: Stronger background color + left border accent
- **Text colors**: Inherit from CodeNomad theme (dark/light)

---

## CSS Classes

```css
.command-suggestions
  .command-suggestions-list
    .command-suggestions-item
      .command-suggestions-item--selected
      .command-suggestions-item-name
      .command-suggestions-item-description
      .command-suggestions-item-usage
    .command-suggestions-empty
    .command-suggestions-scroll
  .command-suggestions-overlay
```

---

## Integration Points

### In PromptInput.tsx

1. **Import**: `import CommandSuggestions from "./command-suggestions"`
2. **Signals to add**:
   ```typescript
   const [commandMode, setCommandMode] = createSignal(false)
   const [commandQuery, setCommandQuery] = createSignal("")
   const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0)
   const [commandSuggestions, setCommandSuggestions] = createSignal<SDKCommand[]>([])
   ```

3. **In handleKeyDown()**:
   ```typescript
   if (key === "!" && !commandMode()) {
     // Check if next will be "/"
     // Mark for possible command mode
   }
   if (key === "/" && lastKeyWas("!")) {
     setCommandMode(true)
     fetchAndSetCommands()
   }
   if (commandMode()) {
     switch (key) {
       case "Escape": setCommandMode(false); break
       case "Backspace": 
         if (commandQuery().length === 0) setCommandMode(false)
         break
       case "ArrowDown": setSelectedCommandIndex(i => i + 1); break
       case "ArrowUp": setSelectedCommandIndex(i => i - 1); break
       case "Enter": handleCommandSelection(); break
     }
   }
   ```

4. **Render**: Inside prompt input JSX:
   ```tsx
   <Show when={commandMode()}>
     <CommandSuggestions
       commands={getCommands(props.instanceId)}
       isOpen={commandMode()}
       searchQuery={commandQuery()}
       selectedIndex={selectedCommandIndex()}
       onSelect={insertCommand}
       onClose={() => setCommandMode(false)}
       onQueryChange={setCommandQuery}
     />
   </Show>
   ```

### Data Flow

```
User types "/" (after "!") 
  ↓
PromptInput detects `!/` via handleKeyDown()
  ↓
setCommandMode(true) + fetch commands
  ↓
CommandSuggestions receives commands prop
  ↓
Filter via filterCommands(commandQuery, commands)
  ↓
User navigates with arrow keys
  ↓
User presses Enter
  ↓
CommandSuggestionItem onClick calls onSelect
  ↓
PromptInput.insertCommand() inserts text
  ↓
setCommandMode(false) to exit
```

---

## Accessibility

- Keyboard navigation fully supported (no mouse required)
- ARIA labels on items
- Focus management (focus input after selection/close)
- Screen reader announcements for selection
- High contrast for selected item

---

## Testing Strategy

### Unit Tests
- Filter function returns correct results
- Component renders with correct number of items
- Keyboard navigation updates selected index correctly
- Click handler calls onSelect properly

### Integration Tests
- `!/` trigger in prompt input opens suggestions
- Selected command inserts correctly into prompt
- ESC closes suggestions
- Works with various command counts (0, 1, 50+)

### Visual Tests
- Z-axis doesn't obscure chat
- Positioning correct on different window sizes
- Colors match theme
- No text overflow or truncation issues
