# Task 050 - Selector Popover Tailwind Refactor

## Goal
Bring `ModelSelector` and `OpencodeBinarySelector` popovers in line with the design tokens, eliminating manual light/dark class stacks.

## Prerequisites
- Task 049 complete (dropdown utility helpers ready).

## Acceptance Criteria
- [ ] `src/components/model-selector.tsx` and `src/components/opencode-binary-selector.tsx` use token-backed utilities for surfaces, borders, focus rings, and typography.
- [ ] Shared selector utilities live in `src/styles/components.css` (e.g., `.selector-trigger`, `.selector-option`, `.selector-section`).
- [ ] All `dark:bg-gray-*` / `text-gray-*` combinations are removed in favor of tokens or newly added utilities.
- [ ] Combobox states (highlighted, selected, disabled) and validation overlays preserve current UX.

## Steps
1. Map all class usages in both selectors, noting duplicated patterns (trigger button, list items, badges).
2. Create selector-specific helpers in `components.css` that rely on tokens.
3. Update component markup to use the helpers and Tailwind utility additions.
4. Verify validation/binary version chips and search input styling in both themes.

## Testing Checklist
- [ ] Run `npm run build`.
- [ ] In dev mode, open the selector popovers, search, and select options to confirm styling and focus rings.

## Dependencies
- Depends on Task 049 dropdown helpers.
- Blocks folder selection advanced settings refactor.

## Estimated Time
1.0 hour

## Notes
- Branch suggestion: `feature/task-050-selector-popover-refactor`.
- Document any intentional color tweaks in the PR if tokens reveal contrast issues.
