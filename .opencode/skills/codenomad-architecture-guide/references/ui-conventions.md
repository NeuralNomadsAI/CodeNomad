# UI Conventions

## Framework: SolidJS

- Components use Solid JSX
- State management via signals: `createSignal()`, `createMemo()`
- Hooks follow `use*` naming convention: `useSpeech()`, `useScrollCache()`
- Effects via `createEffect()`
- Cleanup via `onCleanup()`

## i18n (Internationalization)

Follow the Multi-Language Support rules in `AGENTS.md`. The locale list is `SUPPORTED_LOCALES` in `packages/ui/src/lib/i18n/index.tsx`; `RTL_LOCALES` there marks the right-to-left locales (`he`).

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
- File size thresholds: File Length Guidelines in `AGENTS.md`

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

Follow the Styling Guidelines in `AGENTS.md` and the area document listed under its Area conventions.

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

- **Framework:** `node:test` with `node:assert/strict`, run through `tsx`: `node --conditions=browser --import tsx --test <files>` for UI units
- **UI stores/utilities:** `*.test.ts` alongside source files
- **Example:** `packages/ui/src/stores/session-status.test.ts`
- **Rendering regressions:** `packages/ui/tests/browser/` (Tooling Preferences in `AGENTS.md`)
