# UI Conventions

## Framework: SolidJS

- Components use JSX (not React)
- State management via signals: `createSignal()`, `createMemo()`
- Hooks follow `use*` naming convention: `useSpeech()`, `useScrollCache()`
- Effects via `createEffect()`
- Cleanup via `onCleanup()`

## i18n (Internationalization)

### Runtime API

- **In components:** `const { t } = useI18n()`
- **In stores/non-component code:** `tGlobal("key")`
- **Implementation:** `packages/ui/src/lib/i18n/index.tsx`

### Message Files

- **Location:** `packages/ui/src/lib/i18n/messages/<locale>/`
- **Format:** TypeScript objects with flat dot keys: `"flat.dot.keys": "string"`
- **Merge helper:** `packages/ui/src/lib/i18n/messages/merge.ts`
- **Duplicate keys:** Throw at build time

### Supported Locales (9)

| Locale | Code | Direction |
|--------|------|-----------|
| English | `en` | LTR |
| Spanish | `es` | LTR |
| French | `fr` | LTR |
| Russian | `ru` | LTR |
| Japanese | `ja` | LTR |
| Simplified Chinese | `zh-Hans` | LTR |
| Hebrew | `he` | RTL |
| German | `de` | LTR |
| Nepali | `ne` | LTR |

### Adding a New String

1. Add to `packages/ui/src/lib/i18n/messages/en/*.ts` (appropriate part file)
2. Add same key to each other locale's corresponding file
3. Missing translations fall back to English (then to the key itself)

### Anti-Pattern

```typescript
// ❌ WRONG: Importing English messages directly
import { enMessages } from "../lib/i18n/messages/en"
const text = enMessages["key"]

// ✅ CORRECT: Using the translation function
const { t } = useI18n()
const text = t("key")
```

## Stores

### Pattern

- Signal-based using SolidJS `createSignal()`
- Export signal accessor and setter: `export const [things, setThings] = createSignal(...)`
- Co-locate related stores (e.g., `session-*.ts` files for session management)

### File Size Limits

| Type | Warning | Target Limit |
|------|---------|-------------|
| Source files | >500 lines | <800 lines |
| Test files | >1000 lines | <1000 lines |

### Example Store Structure

```typescript
// packages/ui/src/stores/example.ts
import { createSignal } from "solid-js"

const [items, setItems] = createSignal<Map<string, Item>>(new Map())

export { items, setItems }

export function addItem(item: Item): void {
  setItems((prev) => {
    const next = new Map(prev)
    next.set(item.id, item)
    return next
  })
}
```

## Components

### Styling

- Use existing token/utility CSS layers
- Tokens: `src/styles/tokens.css`
- Utilities: `src/styles/utilities.css`
- Co-locate reusable UI patterns under `src/styles/components/`
- New component styles: place in scoped subdirectory, import from aggregator file

### Pattern

```typescript
// packages/ui/src/components/example.tsx
import { useI18n } from "../lib/i18n"

export function ExampleComponent(props: ExampleProps) {
  const { t } = useI18n()
  
  return (
    <div class="example-class">
      {t("example.key")}
    </div>
  )
}
```

## Testing

- **Framework:** Vitest
- **UI stores/utilities:** `*.test.ts` alongside source files
- **Example:** `packages/ui/src/stores/session-status.test.ts`

## Commit Messages

- Use conventional style subject line
- Body paragraphs explain:
  - User-visible behavior change
  - Implementation approach
  - Edge cases or platform considerations
  - Validation or test coverage
